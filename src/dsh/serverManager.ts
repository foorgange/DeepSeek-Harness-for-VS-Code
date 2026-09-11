import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

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

  constructor(
    private readonly cfg: ServerManagerConfig,
    private readonly onStatus: (status: ServerStatus) => void,
  ) {
    this.lastStatus = { up: false, startedByUs: false, starting: false, url: cfg.url };
  }

  get status(): ServerStatus {
    return this.lastStatus;
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
      return res.ok;
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
    try {
      this.child = spawn(shellCommand(launcher, ["web"]), {
        shell: true,
        stdio: "ignore",
        windowsHide: true,
        // 以 VS Code 当前文件夹作为服务器工作区根目录(而非 VS Code 进程的启动目录)
        cwd: this.cfg.cwd?.(),
        // POSIX 下分离进程组,使服务器在扩展宿主重载后仍存活;Windows 子进程本就独立存活
        detached: process.platform !== "win32",
      });
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
        this.starting = false;
        this.setStatus({ up: false, startedByUs: false, starting: false });
      });
    } catch (error) {
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
        // 成功就绪后复位 starting;否则本次 ensure 返回后,下一次 ensure 永远走等待分支
        this.starting = false;
        return { ok: true };
      }
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
