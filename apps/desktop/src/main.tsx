import ReactDOM from "react-dom/client";
import App from "./App";
import { DetachedMonitor } from "./DetachedMonitor";
import { native } from "./api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";
// Suppress the browser/WebView context menu in every application window.
// Prevent only the native default; React and editor-specific context handlers
// continue receiving the event and can display their own menus.
document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });

const isMonitor = native && getCurrentWindow().label === "monitor";
ReactDOM.createRoot(document.getElementById("root")!).render(isMonitor ? <DetachedMonitor /> : <App />);
