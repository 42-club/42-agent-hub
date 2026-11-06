import type { AgentPortrait } from "@/domain/types";

// Original code-drawn portraits; no third-party character artwork is bundled.
const palette = {
  xiaoman: { background: "#f7e6d3", hair: "#6b493b", shirt: "#cf8052", skin: "#f4d2b3" },
  chenxu: { background: "#e3edf3", hair: "#36444e", shirt: "#6b889c", skin: "#edcfb6" },
  xutang: { background: "#e8eedf", hair: "#685249", shirt: "#849a72", skin: "#f1d4be" },
  zhouye: { background: "#ede7f3", hair: "#403c4f", shirt: "#756783", skin: "#e9c8af" },
  feiyu: { background: "#deedfc", hair: "#547eb0", shirt: "#315886", skin: "#f4ddcf" },
};

export function CharacterPortrait({ character }: { character: AgentPortrait }) {
  const p = palette[character];
  const fish = character === "feiyu", glasses = character === "chenxu", longHair = fish || character === "xiaoman" || character === "xutang";
  return <svg className="character-portrait" viewBox="0 0 80 80" fill="none" aria-hidden="true">
    <rect width="80" height="80" rx="18" fill={p.background} />
    {fish && <><path d="M58 73C63 63 73 67 75 55C80 67 74 75 66 78Z" fill="#5e9dca" /><path d="M24 31L10 24L17 42M56 31L70 24L63 42" fill="#719dca" stroke="#e9f4ff" strokeWidth="3" /></>}
    <path d={longHair ? "M17 57V33C17 5 63 5 63 33V67H17Z" : "M19 40V30C19 7 61 7 61 31V43Z"} fill={p.hair} />
    {character === "xiaoman" && <><circle cx="18" cy="24" r="10" fill={p.hair} /><circle cx="19" cy="25" r="3" fill="#e7b364" /></>}
    <path d="M12 80V73C12 55 68 55 68 73V80" fill={p.shirt} />
    <path d="M34 54V62L40 68L46 62V54" fill={p.skin} />
    <ellipse cx="40" cy="36" rx="18" ry="23" fill={p.skin} />
    <path d={fish ? "M21 34C21 13 52 6 59 30L45 24L37 17L31 32Z" : character === "zhouye" ? "M21 31L19 16L31 18L34 9L43 15L55 12L61 30L48 26L40 20L32 28Z" : "M21 33C19 12 55 5 59 30C48 30 36 24 32 20L26 31Z"} fill={p.hair} />
    {fish && <><path d="M33 14C28 4 42 2 45 9" stroke={p.hair} strokeWidth="3" strokeLinecap="round" /><path d="M23 22Q40 8 58 22" stroke="#f7fbff" strokeWidth="5" strokeLinecap="round" /></>}
    <path d="M29 34H34M46 34H51" stroke={p.hair} strokeWidth="1.8" strokeLinecap="round" />
    <ellipse cx="32" cy="39" rx="2" ry="2.8" fill={fish ? "#315e96" : "#443c3a"} /><ellipse cx="48" cy="39" rx="2" ry="2.8" fill={fish ? "#315e96" : "#443c3a"} />
    {glasses && <g stroke="#475d6b" strokeWidth="1.4"><rect x="25" y="34" width="13" height="11" rx="4" /><rect x="42" y="34" width="13" height="11" rx="4" /><path d="M38 38H42" /></g>}
    {(fish || character === "xiaoman") && <><ellipse cx="27" cy="46" rx="4" ry="2" fill="#eaa89d" opacity=".65" /><ellipse cx="53" cy="46" rx="4" ry="2" fill="#eaa89d" opacity=".65" /></>}
    <path d={fish ? "M37 49Q40 47 43 49" : character === "zhouye" ? "M36 49L44 48" : "M35 48Q40 53 45 48"} stroke="#9a655d" strokeWidth="1.7" strokeLinecap="round" />
    {fish ? <><path d="M26 64L40 71L54 64V80H26Z" fill="#f5f9ff" /><path d="M36 75Q39 71 43 75L46 74L44 78H37Z" fill="#6fa6ce" /><path d="M34 64L40 68L46 64L43 73H37Z" fill="#709aca" /></> : <path d="M29 63L40 69L51 63" stroke="#f6f1e7" strokeWidth="2.5" strokeLinecap="round" />}
    {character === "zhouye" && <><path d="M27 62L49 80" stroke="#443f50" strokeWidth="3" /><rect x="42" y="70" width="16" height="10" rx="2" fill="#444552" /><circle cx="50" cy="75" r="3" fill="#a5b9c5" /></>}
  </svg>;
}
