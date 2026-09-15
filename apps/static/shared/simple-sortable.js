// Minimal Sortable-compatible drag sorting for Robot Dojo.
// Covers the app's current delegated row/group reordering without the vendor
// bundle that was throwing in Chrome on the launch path.
(function () {
  if (typeof window === 'undefined' || window.Sortable) return;

  let active = null;

  function closestWithin(target, selector, root) {
    if (!target || !selector) return null;
    const found = target.closest(selector);
    return found && root.contains(found) ? found : null;
  }

  function groupName(options) {
    const group = options && options.group;
    if (!group) return null;
    return typeof group === 'string' ? group : group.name || null;
  }

  function canReceive(targetSortable) {
    if (!active || !targetSortable) return false;
    const sourceGroup = groupName(active.sortable.options);
    const targetGroup = groupName(targetSortable.options);
    if (!sourceGroup && !targetGroup) return active.sortable === targetSortable;
    return sourceGroup && sourceGroup === targetGroup;
  }

  function placementFor(container, item, pointerY) {
    const selector = item.matches(container._simpleSortable.options.draggable || '> *')
      ? container._simpleSortable.options.draggable
      : null;
    const candidates = Array.from(container.querySelectorAll(selector || container._simpleSortable.options.draggable || ':scope > *'))
      .filter((el) => el !== item && el.parentElement === container);
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect();
      if (pointerY < rect.top + rect.height / 2) return candidate;
    }
    return null;
  }

  class SimpleSortable {
    constructor(el, options) {
      if (!el) throw new Error('Sortable requires an element');
      this.el = el;
      this.options = options || {};
      this.destroyed = false;
      this._bound = {
        pointerdown: this._onPointerDown.bind(this),
        dragstart: this._onDragStart.bind(this),
        dragover: this._onDragOver.bind(this),
        drop: this._onDrop.bind(this),
        dragend: this._onDragEnd.bind(this),
      };
      this._handleOk = false;
      el._simpleSortable = this;
      this.refresh();
      el.addEventListener('pointerdown', this._bound.pointerdown, true);
      el.addEventListener('dragstart', this._bound.dragstart, true);
      el.addEventListener('dragover', this._bound.dragover, true);
      el.addEventListener('drop', this._bound.drop, true);
      el.addEventListener('dragend', this._bound.dragend, true);
    }

    refresh() {
      const selector = this.options.draggable || '> *';
      const items = selector.startsWith('>')
        ? Array.from(this.el.children)
        : Array.from(this.el.querySelectorAll(selector)).filter((node) => node.parentElement === this.el);
      for (const item of items) item.draggable = true;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.el.removeEventListener('pointerdown', this._bound.pointerdown, true);
      this.el.removeEventListener('dragstart', this._bound.dragstart, true);
      this.el.removeEventListener('dragover', this._bound.dragover, true);
      this.el.removeEventListener('drop', this._bound.drop, true);
      this.el.removeEventListener('dragend', this._bound.dragend, true);
      if (this.el._simpleSortable === this) delete this.el._simpleSortable;
    }

    _onPointerDown(event) {
      const handle = this.options.handle;
      this._handleOk = !handle || Boolean(closestWithin(event.target, handle, this.el));
    }

    _onDragStart(event) {
      if (this.destroyed || !this._handleOk) {
        event.preventDefault();
        return;
      }
      const item = closestWithin(event.target, this.options.draggable || '> *', this.el);
      if (!item || item.parentElement !== this.el) return;
      active = { item, from: this.el, sortable: this, dropped: false };
      item.classList.add(this.options.chosenClass || 'sortable-chosen');
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.dataset.slug || item.dataset.sortKey || '');
      } catch {}
    }

    _onDragOver(event) {
      if (!canReceive(this)) return;
      event.preventDefault();
      const item = active.item;
      const before = placementFor(this.el, item, event.clientY);
      if (before && before !== item.nextSibling) {
        this.el.insertBefore(item, before);
      } else if (!before && item.parentElement !== this.el || !before && item !== this.el.lastElementChild) {
        this.el.appendChild(item);
      }
    }

    _onDrop(event) {
      if (!canReceive(this)) return;
      event.preventDefault();
      this._finish(this);
    }

    _onDragEnd() {
      this._finish(this);
    }

    _finish(targetSortable) {
      if (!active || active.dropped) return;
      active.dropped = true;
      const sourceSortable = active.sortable;
      const item = active.item;
      const from = active.from;
      const to = targetSortable && targetSortable.el ? targetSortable.el : item.parentElement;
      item.classList.remove(sourceSortable.options.chosenClass || 'sortable-chosen');
      if (typeof sourceSortable.options.onEnd === 'function') {
        sourceSortable.options.onEnd({ item, from, to });
      }
      active = null;
    }
  }

  window.Sortable = SimpleSortable;
})();
