import "@cloudscape-design/global-styles/index.css";
import "./theme.css"; // 폰트 변수 + 트루 다크 오버레이
import "./useUiSettings"; // 부팅 시 저장된 테마/밀도/모션/폰트를 첫 페인트 전에 적용
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
