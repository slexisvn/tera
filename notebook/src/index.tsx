import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import "./styles/chart.css";
import App from "./app/App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
