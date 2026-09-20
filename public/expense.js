/* The add-expense form: show the right inputs for the chosen split mode and
   check the numbers add up before the server has to say no. The server does the
   same arithmetic in integer cents — this is a courtesy, not the rule. */

const form = document.getElementById('expense-form');
if (form) {
  const mode = document.getElementById('mode');
  const amount = document.getElementById('amount');
  const splitValues = document.getElementById('split-values');
  const totalEl = document.getElementById('split-total');
  const preview = document.getElementById('preview');
  const participants = [...form.querySelectorAll('input[name="participants"]')];

  const chosen = () => participants.filter((box) => box.checked).map((box) => box.dataset.member);

  function parseCents(text) {
    const cleaned = String(text ?? '').trim().replace(/[$€£\s,]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    const [whole, fraction = ''] = cleaned.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  }

  function render() {
    const selected = chosen();
    const perPerson = mode.value === 'equal';
    splitValues.hidden = perPerson;

    for (const label of form.querySelectorAll('.split-label')) {
      label.hidden = !selected.includes(label.dataset.member);
    }
    for (const input of form.querySelectorAll('.split-input')) {
      const active = selected.includes(input.dataset.member);
      input.hidden = !active;
      input.disabled = !active || perPerson;
      if (!perPerson && active) {
        input.placeholder = mode.value === 'percent' ? '%' : mode.value === 'shares' ? '1' : '0.00';
      }
    }

    const total = parseCents(amount.value);
    if (perPerson) {
      preview.textContent =
        total && selected.length
          ? `${selected.length} people · ${(total / 100 / selected.length).toFixed(2)} each, give or take a cent`
          : '';
      totalEl.textContent = '';
      return;
    }
    preview.textContent = '';

    const values = selected.map((id) => Number(form.querySelector(`[name="value_${id}"]`)?.value || 0));
    const sum = values.reduce((acc, value) => acc + value, 0);

    if (mode.value === 'percent') {
      totalEl.textContent = `${Math.round(sum * 100) / 100}% of 100%`;
      totalEl.classList.toggle('bad', Math.abs(sum - 100) > 0.001);
    } else if (mode.value === 'exact') {
      const cents = selected
        .map((id) => parseCents(form.querySelector(`[name="value_${id}"]`)?.value) ?? 0)
        .reduce((acc, value) => acc + value, 0);
      totalEl.textContent = total === null
        ? `${(cents / 100).toFixed(2)} allocated`
        : `${(cents / 100).toFixed(2)} of ${(total / 100).toFixed(2)}`;
      totalEl.classList.toggle('bad', total !== null && cents !== total);
    } else {
      totalEl.textContent = `${sum} share${sum === 1 ? '' : 's'}`;
      totalEl.classList.toggle('bad', sum <= 0);
    }
  }

  form.addEventListener('input', render);
  form.addEventListener('change', render);
  render();
}
