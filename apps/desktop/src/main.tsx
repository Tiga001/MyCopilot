import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { FrontendConfigProvider } from "./config/FrontendConfigProvider";
import { ModelSettingsProvider } from "./config/ModelSettingsProvider";
import { ProjectSettingsProvider } from "./config/ProjectSettingsProvider";
import "./styles/global.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FrontendConfigProvider>
      <ModelSettingsProvider>
        <ProjectSettingsProvider>
          <App />
        </ProjectSettingsProvider>
      </ModelSettingsProvider>
    </FrontendConfigProvider>
  </React.StrictMode>,
);
