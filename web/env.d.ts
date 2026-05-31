/// <reference types="vite/client" />
declare module "*.css";

interface ImportMetaEnv {
  readonly VITE_PI_GUI_PORT?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
