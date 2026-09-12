import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ServerManagerConfig {
  url: string;
  command: string;
  autoStart: boolean;
  timeoutSec: number;
  /** 启动服务器时的工作目录(懒取值:每次启动时读取,通常返回 VS Code 当前文件夹)。 */
  cwd?: () => string | undefined;
  /** 翻译函数;缺省时回退到英文。 */
  t?: (key: string, args?: Record<string, string | number>) => string;
  /** 诊断日志回调(启动器解析 / 进程退出码等),用于输出到日志通道。 */
  onLog?: (message: string) => void;
  /** 服务端的 stdout/stderr 追加到这个文件(懒取值);缺省则丢弃输出。 */
  logFile?: () => string | undefined;
  /** 截获到 0.1.5 的启动令牌时回调(用于换取浏览器会话 Cookie)。 */
  onLaunchToken?: (token: string) => void;
}

export interface ServerStatus {
  up: boolean;
  startedByUs: boolean;
  starting: boolean;
  url: string;
  message?: string;
}

/**
 * DSH Web 服务器生命周期管理:探测、按需自动启动(`dsh web`,回退 npx)、停止(仅限由本扩展启动的进程)。
 */
export class ServerManager {
  private child: ChildProcess | undefined;
  private startedByUs = false;
  private starting = false;
  private lastStatus: ServerStatus;
  /** 由本扩展启动的那个进程打印的启动令牌(0.1.5 才有;0.1.1 为 undefined)。 */
  private launchToken: string | undefined;
  /** 服务端日志文件路径,以及本次启动在文件里的起始偏移(用于只读新增段)。 */
  private logPath: string | undefined;
  private logOffset = 0;

  constructor(
    private readonly cfg: ServerManagerConfig,
    private readonly onStatus: (status: ServerStatus) => void,
  ) {
    this.lastStatus = { up: false, startedByUs: false, starting: false, url: cfg.url };
  }

  get status(): ServerStatus {
    return this.lastStatus;
  }

  /** 启动令牌;仅在「本扩展启动了服务端」且服务端是 0.1.5 时有值。 */
  get token(): string | undefined {
    return this.launchToken;
  }

  private setStatus(patch: Partial<ServerStatus>) {
    this.lastStatus = { ...this.lastStatus, ...patch };
    this.onStatus(this.lastStatus);
  }

  /** 探测服务器是否在运行(2 秒超时)。 */
  async isUp(timeoutMs = 2500): Promise<boolean> {
    try {
      const res = await fetch(this.cfg.url + "/", {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "text/html" },
      });
      // dsh 0.1.5 起根路径也挂了门禁:未认证返回 401,Host 不可信返回 403,
      // 带启动令牌的交换返回 303 —— 这些**都是**「服务端正在跑」的证据。
      // 只看 res.ok 的话,0.1.5 上会被判成「服务端已死」,ensure() 随即再拉起一个进程抢同一端口。
      return res.ok || res.status === 303 || res.status === 401 || res.status === 403;
    } catch {
      return false;
    }
  }

  /** 确保服务器在运行;必要时按配置自动启动。返回是否可用。 */
  async ensure(): Promise<{ up: boolean; message?: string }> {
    if (await this.isUp()) {
      this.setStatus({ up: true, starting: false });
      return { up: true };
    }
    if (!this.cfg.autoStart) {
      const msg = this.cfg.t?.("hub.serverDown", { url: this.cfg.url }) ?? `DSH server is not running (${this.cfg.url}). Run "dsh web" or execute "DSH: Start Server".`;
      this.setStatus({ up: false, starting: false, message: msg });
      return { up: false, message: msg };
    }
    if (this.starting) {
      // 已有启动流程在进行,等它完成
      const deadline = Date.now() + this.cfg.timeoutSec * 1000;
      while (Date.now() < deadline) {
        if (await this.isUp(800)) {
          this.setStatus({ up: true, starting: false });
          return { up: true };
        }
        await sleep(400);
      }
      return { up: false, message: this.cfg.t?.("hub.serverTimeout", { url: this.cfg.url }) ?? `Waiting for the DSH server timed out (${this.cfg.url})` };
    }
    const started = await this.start();
    if (started.ok) {
      this.setStatus({ up: true, starting: false, startedByUs: true });
      return { up: true };
    }
    const detail = started.detail ?? "unknown";
    let msg = this.cfg.t?.("hub.startFailed", { detail }) ?? `Cannot start the DSH server: ${detail}`;
    // 0xC0000142 / EPERM 是环境级进程创建拦截(如从 DSH 会话/受限终端启动 VS Code),给出针对性提示
    if (/3221225794|EPERM|EACCES/.test(detail)) {
      const hint = this.cfg.t?.("hub.startRestrictedHint") ?? "Process creation appears to be blocked by the environment.";
      msg = `${msg} ${hint}`;
    }
    this.setStatus({ up: false, starting: false, message: msg });
    return { up: false, message: msg };
  }

  /** 启动服务器并轮询等待就绪。 */
  private async start(): Promise<{ ok: boolean; detail?: string }> {
    const resolved = await this.resolveLauncher();
    if (!resolved.launcher) {
      const detail = resolved.detail ?? "no launcher found (dsh/npx/npm)";
      this.log(`启动器解析失败: ${detail}`);
      return { ok: false, detail };
    }
    const launcher = resolved.launcher;
    this.log(`使用启动器: ${launcher}`);
    this.starting = true;
    this.setStatus({ starting: true, up: false });
    let childExited = false;
    let exitInfo = "";
    let logFd: number | undefined;
    this.launchToken = undefined;
    try {
      logFd = this.openLogFile();
      this.child = spawn(shellCommand(launcher, ["web"]), {
        shell: true,
        // 服务端输出必须落盘:0.1.5 的启动令牌只出现在它打印的 URL 行里。
        // 用文件而不是管道 —— 扩展宿主退出后管道会断,仍在运行的服务端下一次写
        // stdout 就会 EPIPE 而死;文件没有这个问题,顺带让服务端日志第一次可查。
        stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
        windowsHide: true,
        // 以 VS Code 当前文件夹作为服务器工作区根目录(而非 VS Code 进程的启动目录)
        cwd: this.cfg.cwd?.(),
        // POSIX 下分离进程组,使服务器在扩展宿主重载后仍存活;Windows 子进程本就独立存活
        detached: process.platform !== "win32",
      });
      // 子进程已经拿到自己那份 fd,父进程这份立刻还回去,避免反复重启时泄漏句柄
      if (logFd !== undefined) {
        closeSync(logFd);
        logFd = undefined;
      }
      this.startedByUs = true;
      const child = this.child;
      this.log(`已启动子进程 pid=${child.pid ?? "?"}(首次 npx 下载包可能较慢)`);
      // 闭包捕获本次的 child:迟到的旧子进程回调不得改写新一启动的生命周期状态
      child.once("exit", (code, signal) => {
        const info = `exit code=${code ?? "null"} signal=${signal ?? "none"}`;
        if (this.child !== child) {
          this.log(`旧子进程退出(已被新的启动流程取代): ${info}`);
          return;
        }
        exitInfo = info;
        childExited = true;
        this.log(`子进程退出: ${info}`);
        this.child = undefined;
        this.startedByUs = false;
        this.launchToken = undefined;
        // 退出后必须复位 starting,否则 ensure() 会误判“启动流程仍在进行”而拒绝再次 spawn
        this.starting = false;
        this.setStatus({ up: false, startedByUs: false, starting: false });
      });
      child.once("error", (error) => {
        const info = `spawn error: ${error.message}`;
        if (this.child !== child) {
          this.log(`旧子进程错误(已被新的启动流程取代): ${info}`);
          return;
        }
        exitInfo = info;
        childExited = true;
        this.log(`子进程启动失败: ${info}`);
        this.child = undefined;
        this.startedByUs = false;
        this.launchToken = undefined;
        this.starting = false;
        this.setStatus({ up: false, startedByUs: false, starting: false });
      });
    } catch (error) {
      // spawn 同步抛出时子进程根本没起来,上面那次 closeSync 没执行到 —— 不补这一下,
      // 反复重试启动的机器上会一点一点漏句柄。logFd 在关掉后就置了 undefined,不会重复关。
      if (logFd !== undefined) {
        try {
          closeSync(logFd);
        } catch {
          /* 已经关掉了就算了 */
        }
      }
      this.starting = false;
      this.setStatus({ starting: false });
      const detail = `spawn 抛出异常: ${error instanceof Error ? error.message : String(error)}`;
      this.log(detail);
      return { ok: false, detail };
    }

    const deadline = Date.now() + this.cfg.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (await this.isUp(800)) {
        this.log("服务器已就绪");
        this.captureLaunchToken();
        // 注意:这里**不**等令牌落盘。dsh-web-app 是先 listen、再等整棵插件树
        // `loader.await()` 结束才 announceReady() 打印那行 URL
        // (node_modules/@deepseek-ai/dsh-web-app/lib/index.js:194-215),所以此刻它多半还没打印。
        // 但等待不能放在这儿:start() 的返回时刻是 ensure() 的契约(调用方据此认定
        // 「刚拉起的服务端是活的」),拖长它就会把「启动即崩」误判成「启动成功」。
        // 等待放在真正的消费端 —— ServerManager.waitForToken(),由 createAdapter 调用。
        // 子进程在这几行之间就死掉的话,exit 回调已经复位了 up/startedByUs,而 ensure() 拿到
        // ok 之后会**无条件**再写回 up=true —— 面板显示「已连接」而端口上其实什么都没有,
        // stop() 还会去杀一个已经不存在的 pid。所以这里绝不能报成功。
        if (childExited) {
          this.log(`子进程在就绪的同时退出(${exitInfo}),按启动失败处理`);
          break;
        }
        // 成功就绪后复位 starting;否则本次 ensure 返回后,下一次 ensure 永远走等待分支
        this.starting = false;
        return { ok: true };
      }
      // 令牌在服务端就绪前就打印了,顺路截获,省一次读盘
      this.captureLaunchToken();
      // 子进程提前退出:不再傻等,立即失败并给出退出码(如端口被占用 / npx 报错 / 环境拦截)
      if (childExited) {
        this.log(`子进程在就绪前退出(${exitInfo}),停止等待`);
        break;
      }
      await sleep(500);
    }
    this.starting = false;
    const detail =
      this.cfg.t?.("hub.serverNotReady", { secs: this.cfg.timeoutSec, detail: exitInfo || "no exit info" }) ??
      `DSH server not ready within ${this.cfg.timeoutSec}s (${exitInfo}). It may have started on another port, or the first npx download needs longer than the timeout.`;
    this.setStatus({ starting: false, up: false, message: detail });
    return { ok: false, detail };
  }

  /**
   * 打开(追加)服务端日志文件,并记下本次启动的起始偏移。
   * 未配置或打不开时返回 undefined —— 此时退化成丢弃输出,不影响启动本身。
   */
  private openLogFile(): number | undefined {
    const path = this.cfg.logFile?.();
    if (path === undefined || path === "") return undefined;
    // 每次启动都从干净状态开始:下面任何一步失败,都必须让「本次没有日志文件」成立。
    // 否则 captureLaunchToken 会拿着**上一次**的 logPath/logOffset 去重读旧日志,
    // 把上一个进程的启动令牌当成这一次的交给鉴权 —— 那正是它自己注释里说要防的事。
    this.logPath = undefined;
    this.logOffset = 0;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const size = existsSync(path) ? statSync(path).size : 0;
      const fd = openSync(path, "a");
      this.logPath = path;
      this.logOffset = size;
      this.log(`服务端输出写入 ${path}`);
      return fd;
    } catch (error) {
      this.log(`无法写入服务端日志 ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * 从服务端日志的**本次新增段**里截获启动令牌。
   * `dsh web` 会打印 `dsh web: http://127.0.0.1:3080/?token=<T> (LAN: http://…?token=<T>)`,
   * 一行里可能有两个 URL,只取第一个;只在 spawn 之后新增的部分找,免得读到上一次运行的旧令牌。
   */
  private captureLaunchToken() {
    if (this.launchToken !== undefined || this.logPath === undefined) return;
    let text: string;
    try {
      const size = statSync(this.logPath).size;
      if (size <= this.logOffset) return;
      const fd = openSync(this.logPath, "r");
      try {
        const buffer = Buffer.alloc(size - this.logOffset);
        readSync(fd, buffer, 0, buffer.length, this.logOffset);
        text = buffer.toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    // 逐行找第一个「带 token 参数的 URL」而不是死认第一条 dsh web: 行 ——
    // 同一段输出里还有 `dsh web: opening the default browser…` 这类纯文本行,
    // 一旦打印顺序变了,只取首条就会永远抓不到令牌。
    for (const match of text.matchAll(/dsh web:\s*(\S+)/gu)) {
      let token: string | undefined;
      try {
        token = new URL(match[1]).searchParams.get("token") ?? undefined;
      } catch {
        continue;
      }
      if (token === undefined) continue;
      this.launchToken = token;
      this.log("已截获启动令牌(用于换取浏览器会话 Cookie)");
      this.cfg.onLaunchToken?.(token);
      return;
    }
  }
  /** 找到可用的启动命令:dsh → npx → npm exec 回退(含常见绝对路径,规避 VS Code PATH 不含 node 的问题)。 */
  private async resolveLauncher(): Promise<{ launcher?: string; detail?: string }> {
    const failures: string[] = [];
    const configured = await this.canRun(this.cfg.command);
    if (configured.ok) {
      this.log(`启动器命中配置 dsh.command = ${this.cfg.command}`);
      return { launcher: this.cfg.command };
    }
    failures.push(`${this.cfg.command}:${configured.detail}`);
    this.log(`dsh.command = ${this.cfg.command} 不可用(${configured.detail}),尝试 npx 回退`);
    for (const npx of this.npxCandidates()) {
      const r = await this.canRun(npx);
      if (r.ok) {
        this.log(`npx 可用: ${npx}`);
        return { launcher: `${npx} --yes @deepseek-ai/dsh@latest` };
      }
      failures.push(`${npx}:${r.detail}`);
    }
    for (const npm of this.npmCandidates()) {
      const r = await this.canRun(npm);
      if (r.ok) {
        this.log(`npm 可用: ${npm}`);
        return { launcher: `${npm} exec --yes @deepseek-ai/dsh@latest` };
      }
      failures.push(`${npm}:${r.detail}`);
    }
    return { detail: failures.join("; ") };
  }

  /** npx 候选命令:PATH 中的 npx + Windows 常见 node 安装位置(去重)。 */
  private npxCandidates(): string[] {
    const seen = new Set<string>();
    const candidates: string[] = [];
    const push = (c: string) => {
      if (c && !seen.has(c)) {
        seen.add(c);
        candidates.push(c);
      }
    };
    if (process.platform === "win32") {
      push("npx.cmd");
      push("npx");
      const bases = [
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        process.env.APPDATA ? join(process.env.APPDATA, "npm") : undefined,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "npm") : undefined,
      ];
      for (const base of bases) {
        if (!base) continue;
        push(join(base, "nodejs", "npx.cmd"));
        push(join(base, "npx.cmd"));
      }
      push(join("C:\\Program Files", "nodejs", "npx.cmd"));
      push(join("C:\\Program Files (x86)", "nodejs", "npx.cmd"));
    } else {
      push("npx");
      push("/usr/local/bin/npx");
      push("/opt/homebrew/bin/npx");
    }
    return candidates;
  }

  /** npm 候选命令(与 npx 同位置;npm exec 可作为 npx 的替代)。 */
  private npmCandidates(): string[] {
    const seen = new Set<string>();
    const candidates: string[] = [];
    const push = (c: string) => {
      if (c && !seen.has(c)) {
        seen.add(c);
        candidates.push(c);
      }
    };
    if (process.platform === "win32") {
      push("npm.cmd");
      push("npm");
      const bases = [
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        process.env.APPDATA ? join(process.env.APPDATA, "npm") : undefined,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "npm") : undefined,
      ];
      for (const base of bases) {
        if (!base) continue;
        push(join(base, "nodejs", "npm.cmd"));
        push(join(base, "npm.cmd"));
      }
      push(join("C:\\Program Files", "nodejs", "npm.cmd"));
      push(join("C:\\Program Files (x86)", "nodejs", "npm.cmd"));
    } else {
      push("npm");
      push("/usr/local/bin/npm");
      push("/opt/homebrew/bin/npm");
    }
    return candidates;
  }

  /**
   * 等启动令牌落盘,最多 `timeoutMs`;抓到就立刻返回,超时返回 undefined。
   *
   * 为什么需要等:dsh-web-app 是先 listen、再等整棵插件树 `loader.await()` 结束才
   * announceReady() 打印那行带 token 的 URL(index.js:194-215),所以「端口通了」比
   * 「令牌可读」早 —— 早多少取决于插件树要加载多久,冷启动可能到秒级。
   *
   * 为什么等待放在这里而不是 start() 里:start() 的返回时刻是 ensure() 的契约,调用方
   * 据此认定「刚拉起的服务端是活的」。在 start() 里等,就会把「启动即崩」的服务端也
   * 报成启动成功(exit 回调复位过的 up 会被 ensure() 再写回 true)。而这里纯属消费端的
   * 耐心,等不到也只是退回凭据派生那条鉴权路,不影响任何生命周期判断。
   *
   * 只对**本扩展自己拉起的**服务端有意义:服务端本来就在跑时 this.logPath 是
   * undefined,循环第一次就返回 —— 不会给「连一个已在运行的服务器」加任何延迟。
   */
  async waitForToken(timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.captureLaunchToken();
      if (this.launchToken !== undefined) return this.launchToken;
      // 日志文件都没有(非本扩展启动)或子进程已经没了 —— 再等也不会出现令牌
      if (this.logPath === undefined || this.child === undefined) return undefined;
      if (Date.now() >= deadline) return undefined;
      await sleep(250);
    }
  }

  private log(message: string) {
    this.cfg.onLog?.(`[server] ${message}`);
  }

  private canRun(command: string): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      const args = ["--version"];
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, detail: "timeout(15s)" });
        }
      }, 15_000);
      try {
        const child = spawn(shellCommand(command, args), { shell: true, stdio: "ignore", windowsHide: true });
        child.once("error", (error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, detail: `error ${error.message}` });
          }
        });
        child.once("exit", (code) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: code === 0, detail: `exit ${code}` });
          }
        });
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, detail: `throw ${error instanceof Error ? error.message : String(error)}` });
      }
    });
  }

  /** 停止由本扩展启动的服务器(杀进程树)。 */
  async stop(): Promise<{ ok: boolean; message?: string }> {
    if (!this.startedByUs || !this.child?.pid) {
      return { ok: false, message: this.cfg.t?.("hub.notStartedByUs") ?? "The current server was not started by this extension; stop it in the terminal that launched it." };
    }
    const pid = this.child.pid;
    try {
      if (process.platform === "win32") {
        await runDetached("taskkill", ["/pid", String(pid), "/T", "/F"]);
      } else {
        await runDetached("kill", ["-TERM", "-" + pid]);
        await sleep(500);
        await runDetached("kill", ["-KILL", "-" + pid]).catch(() => undefined);
      }
    } catch (error) {
      return { ok: false, message: this.cfg.t?.("hub.stopFailed", { error: error instanceof Error ? error.message : String(error) }) ?? `Stop failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.startedByUs = false;
    this.child = undefined;
    this.launchToken = undefined;
    this.starting = false;
    this.setStatus({ up: false, startedByUs: false, starting: false });
    return { ok: true };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 拼接 shell 命令(Windows 下为带空格的可执行路径加引号,避免 cmd 截断)。 */
function shellCommand(file: string, args: string[]): string {
  const quote = (s: string) => (process.platform === "win32" && /\s/.test(s) && !/^".*"$/.test(s) ? `"${s}"` : s);
  return [file, ...args].map(quote).join(" ");
}

function runDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}
