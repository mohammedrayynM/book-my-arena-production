function computeOwnerMarkup(original_price, markupType, markupValue, slotCount = 1) {
  const price = Number(parseFloat(original_price)) || 0;
  const type = String(markupType || '').trim().toLowerCase();
  const val = Number(parseFloat(markupValue)) || 0;
  const count = Number(parseInt(slotCount)) || 1;

  let markupAmount = 0;
  if (type === 'fixed') {
    markupAmount = val * count;
  } else if (type === 'percentage') {
    markupAmount = price * (val / 100);
  }

  markupAmount = Math.round(markupAmount * 100) / 100;

  return {
    markupAmount,
    displayPrice: price + markupAmount
  };
}

module.exports = { computeOwnerMarkup };
