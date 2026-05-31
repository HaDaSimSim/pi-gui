import "./globals.css";
import "./use-ui-settings"; // 부팅 시 저장된 테마/폰트를 첫 페인트 전에 적용
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { ErrorBoundary } from "./error-boundary";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
