for (const root of document.querySelectorAll<HTMLElement>('[data-catalog]')) {
  const search = root.querySelector<HTMLInputElement>('[data-catalog-search]');
  const group = root.querySelector<HTMLSelectElement>('[data-catalog-group]');
  const cards = [...root.querySelectorAll<HTMLElement>('[data-catalog-card]')];
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-catalog-filter]')];
  let filter = 'all';
  const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const render = () => {
    const words = normalize(search?.value || '').split(/\s+/).filter(Boolean);
    let visible = 0;
    for (const card of cards) {
      const match = words.every(word => normalize(card.dataset.search || '').includes(word))
        && (filter === 'all' || card.dataset.filter === filter)
        && (!group?.value || card.dataset.group === group.value);
      card.hidden = !match;
      if (match) visible++;
    }
    const count = root.querySelector('[data-catalog-count]');
    const noun = root.querySelector('.hero-grid') ? (visible === 1 ? 'hero' : 'heroes') : (visible === 1 ? 'item' : 'items');
    if (count) count.textContent = `${visible} ${noun}`;
    const empty = root.querySelector<HTMLElement>('[data-catalog-empty]');
    if (empty) empty.hidden = visible > 0;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.catalogFilter === filter)));
  };
  search?.addEventListener('input', render);
  group?.addEventListener('change', render);
  buttons.forEach(button => button.addEventListener('click', () => { filter = button.dataset.catalogFilter || 'all'; render(); }));
  root.querySelector('[data-catalog-reset]')?.addEventListener('click', () => {
    if (search) search.value = '';
    if (group) group.value = '';
    filter = 'all'; render(); search?.focus();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-catalog-share]').forEach(button => button.addEventListener('click', async () => {
    const url = button.dataset.catalogShare!;
    try {
      if (navigator.share) await navigator.share({ title: button.dataset.title, url });
      else { await navigator.clipboard.writeText(url); button.textContent = 'Link copied'; }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      // A selectable URL remains available when clipboard access is denied.
      window.prompt('Copy this item link', url);
    }
  }));
}
