const search = document.querySelector<HTMLInputElement>("[data-faq-search]");
const items = Array.from(document.querySelectorAll<HTMLElement>("[data-faq-item]"));
const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-faq-section]"));
const empty = document.querySelector<HTMLElement>("[data-faq-empty]");

function updateFaqs() {
  const query = search?.value.trim().toLowerCase() ?? "";
  let visibleCount = 0;

  items.forEach((item) => {
    const matches = !query || (item.dataset.faqSearchText ?? "").includes(query);
    item.hidden = !matches;
    if (matches) visibleCount += 1;
  });

  sections.forEach((section) => {
    if (section.dataset.faqSection === "quick-start") {
      section.hidden = query.length > 0;
      return;
    }
    section.hidden = !section.querySelector<HTMLElement>("[data-faq-item]:not([hidden])");
  });

  empty?.classList.toggle("is-visible", visibleCount === 0);
}

search?.addEventListener("input", updateFaqs);

if (location.hash) {
  const target = document.querySelector<HTMLDetailsElement>(location.hash);
  if (target?.matches("details")) target.open = true;
}
