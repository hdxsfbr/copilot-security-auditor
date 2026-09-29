import React, { useCallback, useEffect, useState } from "react";

const currentPath = () => window.location.pathname.replace(/\/+$/, "") || "/";
export function useRouterPath() {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onPopState = () => { setPath(currentPath()); requestAnimationFrame(() => document.getElementById("main-content")?.focus()); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback((next: string) => {
    if (next !== currentPath()) window.history.pushState(null, "", next);
    setPath(currentPath());
    window.scrollTo(0, 0);
    requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  }, []);
  return { path, navigate };
}

export function RouteLink({ href, navigate, children, ...props }: React.PropsWithChildren<{ href: string; navigate: (path: string) => void } & React.AnchorHTMLAttributes<HTMLAnchorElement>>) {
  return <a href={href} {...props} onClick={event => {
    props.onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target) return;
    event.preventDefault(); navigate(href);
  }}>{children}</a>;
}
