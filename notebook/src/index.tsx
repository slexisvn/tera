import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import "./styles/chart.css";
import "./styles/docs.css";
import App from "./app/App";
import { DocsPage } from "./app/DocsPage";
import { useHashRoute } from "./utils/hash-route";

function Root() {
  const route = useHashRoute();
  return route === "/docs" ? <DocsPage /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
