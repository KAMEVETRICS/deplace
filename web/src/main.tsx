import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { SessionProvider } from "./session.js";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/source-sans-3";
import "./styles.css";

// Some Concordium SDK paths expect a global Buffer in the browser.
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
