import React from "react";

export const markdownComponents = {
  h1: ({ children }) => <h2>{children}</h2>,
  a: ({ href, children }) => {
    if (href?.startsWith("#")) return <a href={href}>{children}</a>;
    if (!/^https?:\/\//i.test(href ?? "")) return <span>{children}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  table: ({ children }) => (
    <div className="diary-table">
      <table>{children}</table>
    </div>
  ),
};
