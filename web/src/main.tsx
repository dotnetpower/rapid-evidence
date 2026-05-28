import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./components/AppShell";
import { ThroughputPage } from "./pages/ThroughputPage";
import { BatchesPage } from "./pages/BatchesPage";
import { AuditPage } from "./pages/AuditPage";
import { ScalingTimelinePage } from "./pages/ScalingTimelinePage";
import { QuotaPage } from "./pages/QuotaPage";
// Code-split: the regions page pulls in leaflet (~150 KB gzip) which
// no other page uses. Loading it on demand keeps the initial bundle
// lean for the default route.
const RegionsPage = lazy(() =>
  import("./pages/RegionsPage").then((m) => ({ default: m.RegionsPage })),
);
import { I18nProvider } from "./lib/i18n";
import "./styles/tokens.css";
import "./styles/app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<ThroughputPage />} />
              <Route path="/batches" element={<BatchesPage />} />
              <Route path="/batches/:batchId" element={<BatchesPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/scaling" element={<ScalingTimelinePage />} />
              <Route path="/quota" element={<QuotaPage />} />
              <Route
                path="/regions"
                element={
                  <Suspense fallback={<div className="empty" style={{ padding: 24 }}>loading map…</div>}>
                    <RegionsPage />
                  </Suspense>
                }
              />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>
);
