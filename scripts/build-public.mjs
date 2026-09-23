// Vercel 빌드: CSS·JS·이미지만 public/ 으로 복사한다.
// 화면(.html)은 복사하지 않는다 — 로그인 확인을 거치도록 서버 함수(api/index.py)가 내준다.
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "public");
const SKIP = new Set(["public", "api", "server", "scripts", "deploy", "data", "node_modules", ".git", ".vercel", "venv", ".venv"]);
const ASSETS = new Set([".css", ".js", ".svg", ".png", ".ico", ".webp", ".jpg", ".woff2"]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let count = 0;
function walk(dir, rel) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || (!rel && SKIP.has(name))) continue;
    const src = join(dir, name);
    const r = rel ? rel + "/" + name : name;
    if (statSync(src).isDirectory()) walk(src, r);
    else if (rel && ASSETS.has(extname(name).toLowerCase())) {
      mkdirSync(join(OUT, rel), { recursive: true });
      cpSync(src, join(OUT, r));
      count++;
    }
  }
}
walk(ROOT, "");
console.log("public/ 에 정적 파일 " + count + "개를 복사했습니다.");
