export {};

const root = document.documentElement;
const body = document.body;

function setTheme(theme: "light" | "dark") {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelectorAll<HTMLElement>("[data-theme-icon-light]").forEach((icon) => {
    icon.hidden = theme === "light";
  });
  document.querySelectorAll<HTMLElement>("[data-theme-icon-dark]").forEach((icon) => {
    icon.hidden = theme === "dark";
  });
  document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((button) => {
    button.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
  });
}

function showToast(message: string) {
  const toast = document.querySelector<HTMLElement>("[data-toast]");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

setTheme(root.dataset.theme === "light" ? "light" : "dark");

document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem("nutcx-theme", next); } catch { /* Storage can be unavailable. */ }
  });
});

const navToggle = document.querySelector<HTMLButtonElement>("[data-nav-toggle]");
const primaryNavigation = document.querySelector<HTMLElement>("[data-primary-nav]");

function setNavigation(open: boolean) {
  if (!navToggle || !primaryNavigation) return;
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  primaryNavigation.classList.toggle("is-open", open);
  body.classList.toggle("nav-open", open);
  const openIcon = navToggle.querySelector<HTMLElement>("[data-nav-icon-open]");
  const closeIcon = navToggle.querySelector<HTMLElement>("[data-nav-icon-close]");
  if (openIcon) openIcon.hidden = open;
  if (closeIcon) closeIcon.hidden = !open;
}

navToggle?.addEventListener("click", () => setNavigation(navToggle.getAttribute("aria-expanded") !== "true"));
primaryNavigation?.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => link.addEventListener("click", () => setNavigation(false)));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setNavigation(false);
});

document.querySelectorAll<HTMLElement>("[data-current-year]").forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});

document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const value = button.dataset.copy ?? "";
    try {
      await navigator.clipboard.writeText(value);
      showToast(button.dataset.copyMessage ?? "Copied to clipboard");
    } catch {
      showToast("Copy failed. Select the text manually.");
    }
  });
});

const header = document.querySelector<HTMLElement>("[data-site-header]");
const updateHeader = () => header?.classList.toggle("is-scrolled", window.scrollY > 8);
updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!reduceMotion && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-revealed");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((element) => observer.observe(element));
} else {
  document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((element) => element.classList.add("is-revealed"));
}

root.classList.add("js-ready");

declare global {
  interface Window { nutcxToast?: (message: string) => void; }
}
window.nutcxToast = showToast;
