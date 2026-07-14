import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import DocsPage from "./pages/DocsPage";
import LandingPage from "./pages/LandingPage";

export default function App() {
  return (
    <TooltipProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/docs" element={<Navigate to="/docs/introduce" replace />} />
          <Route path="/docs/:pageId" element={<DocsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster richColors closeButton position="top-center" />
    </TooltipProvider>
  );
}
