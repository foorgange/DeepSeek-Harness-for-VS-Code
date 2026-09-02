import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 回合级 Git 回退服务端插件的自动安装器。
 *
 * 快照与回退执行由 DSH 服务端插件 `dsh-git-rollback` 承担(命令 /rollback /redo /checkpoints)。
 * 为了让所有扩展用户开箱即用,扩展把编译好的插件打进 vsix 的
 * `resources/dsh-git-rollback/`,激活时自动安装进用户的 DSH web profile:
 *   1. 复制插件包到 `<dshHome>/profiles/web/node_modules/dsh-git-rollback`(带版本标记,幂等增量更新);
 *   2. 在 `profiles/web/cordis.patch.yml` 追加插件装载行(已存在则跳过);
 *   3. 在 profile 的 package.json 写入 file: 依赖(便于日后 pnpm 规范化安装)。
 * 安装不影响服务器运行;新行在服务器下次启动时生效(扩展连接后检测并提示重启)。
 */

const PROFILE = "web";
const PLUGIN_NAME = "dsh-git-rollback";
const VERSION_FILE = ".dsh-version";

export interface InstallResult {
  /** 插件文件是否已就位(本次或之前)。 */
  installed: boolean;
  /** 本次是否发生了写入(新增/升级)。 */
  changed: boolean;
  reason?: string;
}

/** DSH 主目录:优先 DSH_HOME 环境变量,否则 ~/.dsh。 */
export function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  if (env) return env;
  return join(homedir(), ".dsh");
}

function readJson(file: string): unknown {
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function readVersion(dir: string): string {
  try {
    const pkg = readJson(join(dir, "package.json")) as { version?: string };
    return String(pkg.version ?? "").trim();
  } catch {
    return "";
  }
}

/** 把编译好的插件装进用户的 DSH web profile(幂等;失败不抛出,返回 reason)。 */
export async function ensureRollbackPluginInstalled(bundledDir: string): Promise<InstallResult> {
  try {
    const profileDir = join(dshHome(), "profiles", PROFILE);
    // profile 尚未初始化(dsh web 还没跑过):等服务器启动创建后再装,调用方会在服务器上线后重试
    if (!existsSync(join(profileDir, "cordis.patch.yml"))) {
      return { installed: false, changed: false, reason: "profile-missing" };
    }
    const bundledVersion = readVersion(bundledDir);
    const targetDir = join(profileDir, "node_modules", PLUGIN_NAME);
    const installedVersion = existsSync(join(targetDir, VERSION_FILE))
      ? readFileSync(join(targetDir, VERSION_FILE), "utf8").trim()
      : "";
    const filesUpToDate = Boolean(bundledVersion && installedVersion === bundledVersion);
    if (filesUpToDate) {
      // 文件已就位:跳过复制,但仍要幂等对齐 file: 依赖 —— 扩展自升级后 bundledDir 会指向
      // 新版本目录,而 package.json 里的 file: 路径是首次安装时写死的旧目录(升级后已被删除),
      // 若不迁移,profile 里任何 pnpm / `dsh plugin` 操作都会报 ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND。
      return {
        installed: true,
        changed: syncManifestDependency(profileDir, bundledDir),
      };
    }

    // 1) 复制插件包(先清旧目录,避免残留旧文件)
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(join(targetDir, "lib"), { recursive: true });
    for (const file of readdirSync(join(bundledDir, "lib"))) {
      copyFileSync(join(bundledDir, "lib", file), join(targetDir, "lib", file));
    }
    copyFileSync(join(bundledDir, "package.json"), join(targetDir, "package.json"));
    writeFileSync(join(targetDir, VERSION_FILE), bundledVersion || "0");

    // 2) cordis.patch.yml 追加插件装载行(顶部注释 + 末尾 `[]` 的默认形态要原地替换)
    const patchFile = join(profileDir, "cordis.patch.yml");
    const patchContent = readFileSync(patchFile, "utf8");
    if (!patchContent.includes(PLUGIN_NAME)) {
      const block =
        `- insert:\n` +
        `    - id: git-rollback\n` +
        `      name: ${PLUGIN_NAME}\n` +
        `      config:\n` +
        `        enabled: true\n` +
        `        gitBin: git\n` +
        `        commitPrefix: "dsh-checkpoint"\n` +
        `        refPrefix: "refs/dsh"\n`;
      const trimmedEnd = patchContent.trimEnd();
      if (trimmedEnd.endsWith("[]")) {
        writeFileSync(patchFile, trimmedEnd.slice(0, trimmedEnd.lastIndexOf("[]")) + block);
      } else {
        writeFileSync(patchFile, trimmedEnd + "\n" + block);
      }
    }

    // 3) profile package.json 依赖(file: 指向扩展内置资源,日后 pnpm install 可规范化)。
    //    与文件复制解耦:即使文件已是最新,只要依赖 key 存在但指向过期路径(扩展升级前
    //    写入的旧版本目录),也要迁移到当前 bundledDir。
    syncManifestDependency(profileDir, bundledDir);
    // 走到这里说明插件文件本次被重新复制(changed=true);依赖迁移作为副作用已同步执行
    return { installed: true, changed: true };
  } catch (error) {
    console.error("[dsh] rollback plugin install failed:", error);
    return { installed: false, changed: false, reason: String(error) };
  }
}

/** 幂等对齐 profile package.json 的 file: 依赖:缺失则新增,指向过期路径则迁移到当前 bundledDir。返回是否发生写入。 */
function syncManifestDependency(profileDir: string, bundledDir: string): boolean {
  const manifestFile = join(profileDir, "package.json");
  if (!existsSync(manifestFile)) return false;
  try {
    const manifest = readJson(manifestFile) as { dependencies?: Record<string, string> };
    const existing = manifest.dependencies?.[PLUGIN_NAME];
    // 只处理本扩展自己写入的 file: 依赖:缺失则补上,路径过期(指向已删除的旧版本扩展目录)则迁移。
    // 用户手动 pin 成 registry/git 版本等非 file: spec 时保持尊重,不覆盖。
    if (existing !== undefined && !existing.startsWith("file:")) return false;
    const dependency = `file:${bundledDir.replace(/\\/g, "/")}`;
    if (existing === dependency) return false;
    manifest.dependencies = {
      ...(manifest.dependencies ?? {}),
      [PLUGIN_NAME]: dependency,
    };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    return true;
  } catch {
    // profile package.json 损坏时跳过依赖写入,不影响核心安装
    return false;
  }
}
