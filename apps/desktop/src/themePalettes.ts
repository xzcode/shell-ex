import type { AppSettings } from "./types";
import type { ITheme } from "@xterm/xterm";

type ThemeId = Exclude<AppSettings["theme"], "dark">;
type ThemePalette = {
  terminal: ITheme;
  editor: {
    base: "vs" | "vs-dark";
    background: string;
    foreground: string;
    lineNumber: string;
    lineHighlight: string;
    selection: string;
    border: string;
  };
};
// The terminal backgrounds match the --terminal tokens in styles.css.
export const themePalettes: Record<ThemeId, ThemePalette> = {
  "graphite": {"terminal":{"background":"#191e26","foreground":"#e6edf3","cursor":"#a5c9f5","cursorAccent":"#191e26","selectionBackground":"#40566e","black":"#252525","red":"#ee929a","green":"#8ed4af","yellow":"#e8c080","blue":"#9abfee","magenta":"#cda8ec","cyan":"#8ed0d8","white":"#dedede","brightBlack":"#a4a4a4","brightRed":"#ffc0c5","brightGreen":"#b5edc9","brightYellow":"#ffe0a7","brightBlue":"#c1d9ff","brightMagenta":"#e4c9ff","brightCyan":"#b4ecf2","brightWhite":"#f4f4f4"},"editor":{"base":"vs-dark","background":"#191e26","foreground":"#e6edf3","lineNumber":"#aebdcb","lineHighlight":"#2a3440","selection":"#40566e","border":"#526171"}},
  "black": {"terminal":{"background":"#000000","foreground":"#eeeeee","cursor":"#dedede","cursorAccent":"#000000","selectionBackground":"#404040","black":"#171717","red":"#ee929a","green":"#8ed4af","yellow":"#e8c080","blue":"#9abfee","magenta":"#cda8ec","cyan":"#8ed0d8","white":"#dedede","brightBlack":"#939393","brightRed":"#ffc0c5","brightGreen":"#b5edc9","brightYellow":"#ffe0a7","brightBlue":"#c1d9ff","brightMagenta":"#e4c9ff","brightCyan":"#b4ecf2","brightWhite":"#f4f4f4"},"editor":{"base":"vs-dark","background":"#000000","foreground":"#eeeeee","lineNumber":"#b7b7b7","lineHighlight":"#1b1b1b","selection":"#404040","border":"#505050"}},
  "gray": {"terminal":{"background":"#303030","foreground":"#f0f0f0","cursor":"#b9d3ef","cursorAccent":"#303030","selectionBackground":"#526575","black":"#161616","red":"#ee929a","green":"#8ed4af","yellow":"#e8c080","blue":"#9abfee","magenta":"#cda8ec","cyan":"#8ed0d8","white":"#dedede","brightBlack":"#b1b1b1","brightRed":"#ffc0c5","brightGreen":"#b5edc9","brightYellow":"#ffe0a7","brightBlue":"#c1d9ff","brightMagenta":"#e4c9ff","brightCyan":"#b4ecf2","brightWhite":"#f4f4f4"},"editor":{"base":"vs-dark","background":"#303030","foreground":"#f0f0f0","lineNumber":"#d2d2d2","lineHighlight":"#414141","selection":"#526575","border":"#6b6b6b"}},
  "aurora": {"terminal":{"background":"#151e1c","foreground":"#e7f0eb","cursor":"#a0d9c5","cursorAccent":"#151e1c","selectionBackground":"#456555","black":"#252525","red":"#ee929a","green":"#8bd5b4","yellow":"#e8c080","blue":"#9cc8df","magenta":"#cda8ec","cyan":"#8bd5c3","white":"#dedede","brightBlack":"#a4a4a4","brightRed":"#ffc0c5","brightGreen":"#b5edc9","brightYellow":"#ffe0a7","brightBlue":"#c1d9ff","brightMagenta":"#e4c9ff","brightCyan":"#b4ecf2","brightWhite":"#f4f4f4"},"editor":{"base":"vs-dark","background":"#151e1c","foreground":"#e7f0eb","lineNumber":"#b3c8bc","lineHighlight":"#293a31","selection":"#456555","border":"#50695c"}},
  "soft-white": {"terminal":{"background":"#efeeea","foreground":"#272a28","cursor":"#355f80","cursorAccent":"#efeeea","selectionBackground":"#c7d7e2","black":"#31332f","red":"#9f3547","green":"#236547","yellow":"#765719","blue":"#2c5f9c","magenta":"#75439b","cyan":"#246e76","white":"#d2d4cf","brightBlack":"#5f645d","brightRed":"#aa3444","brightGreen":"#206c4e","brightYellow":"#795b1b","brightBlue":"#2d61a0","brightMagenta":"#7943a1","brightCyan":"#246d75","brightWhite":"#f5f5f2"},"editor":{"base":"vs","background":"#efeeea","foreground":"#272a28","lineNumber":"#505750","lineHighlight":"#e0e2dc","selection":"#c7d7e2","border":"#a9aca6"}},
  "mist": {"terminal":{"background":"#fbfbfa","foreground":"#26333d","cursor":"#2e6699","cursorAccent":"#fbfbfa","selectionBackground":"#d1e2f1","black":"#31332f","red":"#9f3547","green":"#236547","yellow":"#765719","blue":"#2c5f9c","magenta":"#75439b","cyan":"#246e76","white":"#d2d4cf","brightBlack":"#5f645d","brightRed":"#aa3444","brightGreen":"#206c4e","brightYellow":"#795b1b","brightBlue":"#2d61a0","brightMagenta":"#7943a1","brightCyan":"#246d75","brightWhite":"#f5f5f2"},"editor":{"base":"vs","background":"#fbfbfa","foreground":"#26333d","lineNumber":"#495d6d","lineHighlight":"#e3e9ee","selection":"#d1e2f1","border":"#adbcc9"}},
  "light": {"terminal":{"background":"#fbfcfe","foreground":"#243247","cursor":"#2c5f9c","cursorAccent":"#fbfcfe","selectionBackground":"#d3e2f7","black":"#31332f","red":"#9f3547","green":"#236547","yellow":"#765719","blue":"#2c5f9c","magenta":"#75439b","cyan":"#246e76","white":"#d2d4cf","brightBlack":"#5f645d","brightRed":"#aa3444","brightGreen":"#206c4e","brightYellow":"#795b1b","brightBlue":"#2d61a0","brightMagenta":"#7943a1","brightCyan":"#246d75","brightWhite":"#f5f5f2"},"editor":{"base":"vs","background":"#fbfcfe","foreground":"#243247","lineNumber":"#4b607a","lineHighlight":"#e8eff7","selection":"#d3e2f7","border":"#aabbd0"}},
};

export function normalizeThemeId(theme: string | undefined): ThemeId {
  if (theme && Object.hasOwn(themePalettes, theme)) return theme as ThemeId;
  return "graphite";
}
export function terminalTheme(theme: string | undefined): ITheme {
  return themePalettes[normalizeThemeId(theme)].terminal;
}
