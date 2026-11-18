import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "misans/lib/Normal/MiSans-Regular.min.css";
import "misans/lib/Normal/MiSans-Medium.min.css";

import "../../../packages/tokens/tokens.css";
import "./rename.css";
import { initPrefs } from "../../../packages/i18n/prefs";
import App from "./App";

// 在首帧前应用主题与语言，并从外壳拉取 Shadowmoon 家族共享的偏好
initPrefs();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
