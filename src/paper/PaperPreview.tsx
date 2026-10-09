import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { PaperProject } from "../../shared/paper-types";

export default function PaperPreview({
  content,
  project,
}: {
  content: string;
  project?: PaperProject;
}) {
  const resolved = content.replace(/\[fig:([A-Za-z0-9_-]+)\]/g,(_all,key)=>{
    const index=project?.modules.figures.assetIds.findIndex(id=>{
      const a=project.assets.find(a=>a.id===id); return (a?.key??a?.id)===key;
    })??-1;
    return index>=0 ? `Figure ${index+1}` : `[Unknown figure: ${key}]`;
  }).replace(/\[@([^\]]+)\]/g, (_all, keys: string) => {
    return (
      "[" +
      keys
        .split(/\s*;\s*/)
        .map((key) => {
          const clean = key.replace(/^@/, "").trim(),
            index = project?.citations.findIndex((c) => c.key === clean) ?? -1;
          return index >= 0
            ? `[${index + 1}](#ref-${clean})`
            : `UNVERIFIED: ${clean}`;
        })
        .join(", ") +
      "]"
    );
  });
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        [rehypeKatex, { strict: false, trust: false, throwOnError: false }],
      ]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            target={href?.startsWith("#") ? undefined : "_blank"}
            rel="noreferrer"
          >
            {children}
          </a>
        ),
        img: ({ alt }) => (
          <span>[Image: {alt}; register through the figure module]</span>
        ),
      }}
    >
      {resolved}
    </Markdown>
  );
}
