import React from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { App } from "./App.jsx";
import { AuthBoundary } from "./features/auth/auth-boundary.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    <AuthBoundary><App /></AuthBoundary>
  </ThemeProvider>,
);
