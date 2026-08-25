import React from "react";
import { createRoot } from "react-dom/client";
import "@tera/ui/tokens.css";
import "@tera/ui/shell.css";
import "@tera/editor/editor.css";
import "./styles/app.css";
import App from "./app/App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
