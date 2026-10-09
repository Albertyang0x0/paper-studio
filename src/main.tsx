import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import './styles/theme.css';
const App = lazy(() =>
  location.pathname.startsWith("/figure")
    ? import("./figure/FigureEditor")
    : import("./paper/PaperWorkbench"),
);
createRoot(document.getElementById("root")!).render(
  <Suspense fallback={<p style={{ padding: 40 }}>正在载入论文工作台…</p>}>
    <App />
  </Suspense>,
);
