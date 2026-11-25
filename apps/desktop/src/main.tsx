import ReactDOM from "react-dom/client";
import App from "./App";
import { DetachedMonitor } from "./DetachedMonitor";
import { native } from "./api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";
const isMonitor = native && getCurrentWindow().label === "monitor";
ReactDOM.createRoot(document.getElementById("root")!).render(isMonitor ? <DetachedMonitor /> : <App />);
