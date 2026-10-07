import { Bot, Orbit } from "lucide-react";
import type { CSSProperties } from "react";
import type { StaticImageData } from "next/image";
import type { GameMode } from "@/domain/types";
import claude from "@lobehub/icons-static-svg/icons/claude-color.svg";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import meta from "@lobehub/icons-static-svg/icons/meta-color.svg";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import grok from "@lobehub/icons-static-svg/icons/grok.svg";
import zai from "@lobehub/icons-static-svg/icons/zai.svg";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import nvidia from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import cohere from "@lobehub/icons-static-svg/icons/cohere-color.svg";
import aws from "@lobehub/icons-static-svg/icons/aws-color.svg";
import arcee from "@lobehub/icons-static-svg/icons/arcee-color.svg";
import bytedance from "@lobehub/icons-static-svg/icons/bytedance-color.svg";
import ibm from "@lobehub/icons-static-svg/icons/ibm.svg";
import inception from "@lobehub/icons-static-svg/icons/inception.svg";
import kwaipilot from "@lobehub/icons-static-svg/icons/kwaipilot-color.svg";
import liquid from "@lobehub/icons-static-svg/icons/liquid.svg";
import longcat from "@lobehub/icons-static-svg/icons/longcat-color.svg";
import poolside from "@lobehub/icons-static-svg/icons/poolside-color.svg";
import relace from "@lobehub/icons-static-svg/icons/relace.svg";
import stepfun from "@lobehub/icons-static-svg/icons/stepfun-color.svg";
import hunyuan from "@lobehub/icons-static-svg/icons/hunyuan-color.svg";
import upstage from "@lobehub/icons-static-svg/icons/upstage-color.svg";
import xiaomi from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import aionlabs from "@lobehub/icons-static-svg/icons/aionlabs-color.svg";
import antgroup from "@lobehub/icons-static-svg/icons/antgroup-color.svg";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg";

type IconAsset = string | StaticImageData;
type VendorBrand = { id: string; foreground: string; background: string; asset?: IconAsset };
const brand = (id: string, asset: IconAsset, background = "#e6ebde"): VendorBrand => ({ id, asset, foreground: "#52654f", background });

// Model-family marks are supplied by Lobe Icons, not redrawn approximations.
const BRANDS: Record<string, VendorBrand> = {
  anthropic: brand("anthropic", claude, "#f0e0d2"),
  openai: brand("openai", openai, "#e0e9df"),
  google: brand("google", gemini, "#e8edf3"),
  deepseek: brand("deepseek", deepseek, "#e3e9f5"),
  meta: brand("meta", meta, "#e0ebf1"),
  qwen: brand("qwen", qwen, "#e9e3f2"),
  mistral: brand("mistral", mistral, "#f4e8ce"),
  xai: brand("xai", grok, "#e8e7e3"),
  zai: brand("zai", zai, "#e7e9ee"),
  moonshot: brand("moonshot", kimi, "#e5eaf5"),
  minimax: brand("minimax", minimax, "#f3e6eb"),
  nvidia: brand("nvidia", nvidia, "#edf0de"),
  cohere: brand("cohere", cohere),
  amazon: brand("amazon", aws, "#f4e8ce"),
  arceeai: brand("arcee", arcee),
  bytedanceseed: brand("bytedance", bytedance, "#e0ebf1"),
  ibmgranite: brand("ibm", ibm, "#e8edf3"),
  inception: brand("inception", inception),
  kwaipilot: brand("kwaipilot", kwaipilot, "#f4e8ce"),
  liquid: brand("liquid", liquid),
  meituan: brand("meituan", longcat, "#f4edce"),
  poolside: brand("poolside", poolside, "#e0ebf1"),
  relace: brand("relace", relace),
  stepfun: brand("stepfun", stepfun, "#e8edf3"),
  tencent: brand("tencent", hunyuan, "#e8edf3"),
  upstage: brand("upstage", upstage, "#f0e6ed"),
  xiaomi: brand("xiaomi", xiaomi, "#f4e8ce"),
  aionlabs: brand("aionlabs", aionlabs),
  inclusionai: brand("inclusionai", antgroup, "#e8edf3"),
  openrouter: brand("openrouter", openrouter, "#e8edf3"),
};
const ALIASES: Record<string, string> = {
  claude: "anthropic", gemini: "google", googledeepmind: "google", metallama: "meta", llama: "meta",
  alibaba: "qwen", mistralai: "mistral", grok: "xai", zhipu: "zai", glm: "zai", kimi: "moonshot",
  moonshotai: "moonshot", aws: "amazon", arcee: "arceeai", bytedance: "bytedanceseed", ibm: "ibmgranite",
  longcat: "meituan", hunyuan: "tencent",
};
const UNKNOWN: VendorBrand = { id: "other", foreground: "#67745a", background: "#e6ebde" };

export function brandForVendor(vendor: string): VendorBrand {
  const key = vendor.toLowerCase().replace(/[^a-z0-9]/g, "");
  return BRANDS[ALIASES[key] ?? key] ?? UNKNOWN;
}

export function VendorMark({ vendor }: { vendor: string }) {
  const { asset } = brandForVendor(vendor);
  // Static SVG imports are fingerprinted and served locally by Next.js.
  const src = typeof asset === "string" ? asset : asset?.src;
  return src ? <img src={src} alt="" width={32} height={32} draggable={false} className="vendor-mark" /> : <Bot strokeWidth={1.6} />;
}

const GAME_ICONS: Record<GameMode, string> = {
  debate: "/icons/games/discussion.svg", undercover: "/icons/games/spy.svg", werewolf: "/icons/games/wolf-howl.svg",
};
export function GameIcon({ mode }: { mode: GameMode }) {
  return <span className="game-icon" aria-hidden="true" style={{ "--game-icon": `url("${GAME_ICONS[mode]}")` } as CSSProperties} />;
}

export function HubLogo({ small = false }: { small?: boolean }) {
  return <span className={`hub-logo ${small ? "small" : ""}`} aria-hidden="true"><Orbit strokeWidth={1.7} /></span>;
}

export function IconCredits() {
  return <details className="icon-credits"><summary>图标来源</summary><p>模型与厂商标识来自 <a href="https://github.com/lobehub/lobe-icons" target="_blank" rel="noreferrer">Lobe Icons</a>（MIT），品牌归各自权利人所有。平台与操作图标来自 <a href="https://lucide.dev/" target="_blank" rel="noreferrer">Lucide</a>（ISC）。</p><p>玩法图标来自 <a href="https://game-icons.net/" target="_blank" rel="noreferrer">Game-icons.net</a>：<a href="https://game-icons.net/1x1/delapouite/discussion.html" target="_blank" rel="noreferrer">Discussion</a>、<a href="https://game-icons.net/1x1/delapouite/spy.html" target="_blank" rel="noreferrer">Spy</a> © Delapouite；<a href="https://game-icons.net/1x1/lorc/wolf-howl.html" target="_blank" rel="noreferrer">Wolf howl</a> © Lorc。按 <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noreferrer">CC BY 3.0</a> 使用，保留原图形，仅调整显示尺寸和颜色。</p></details>;
}
