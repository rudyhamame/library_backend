const forms = {
  'ء':['\uFE80'], 'آ':['\uFE81','\uFE82'], 'أ':['\uFE83','\uFE84'], 'ؤ':['\uFE85','\uFE86'], 'إ':['\uFE87','\uFE88'], 'ئ':['\uFE89','\uFE8A','\uFE8B','\uFE8C'],
  'ا':['\uFE8D','\uFE8E'], 'ب':['\uFE8F','\uFE90','\uFE91','\uFE92'], 'ة':['\uFE93','\uFE94'], 'ت':['\uFE95','\uFE96','\uFE97','\uFE98'], 'ث':['\uFE99','\uFE9A','\uFE9B','\uFE9C'],
  'ج':['\uFE9D','\uFE9E','\uFE9F','\uFEA0'], 'ح':['\uFEA1','\uFEA2','\uFEA3','\uFEA4'], 'خ':['\uFEA5','\uFEA6','\uFEA7','\uFEA8'], 'د':['\uFEA9','\uFEAA'], 'ذ':['\uFEAB','\uFEAC'],
  'ر':['\uFEAD','\uFEAE'], 'ز':['\uFEAF','\uFEB0'], 'س':['\uFEB1','\uFEB2','\uFEB3','\uFEB4'], 'ش':['\uFEB5','\uFEB6','\uFEB7','\uFEB8'],
  'ص':['\uFEB9','\uFEBA','\uFEBB','\uFEBC'], 'ض':['\uFEBD','\uFEBE','\uFEBF','\uFEC0'], 'ط':['\uFEC1','\uFEC2','\uFEC3','\uFEC4'], 'ظ':['\uFEC5','\uFEC6','\uFEC7','\uFEC8'],
  'ع':['\uFEC9','\uFECA','\uFECB','\uFECC'], 'غ':['\uFECD','\uFECE','\uFECF','\uFED0'], 'ف':['\uFED1','\uFED2','\uFED3','\uFED4'], 'ق':['\uFED5','\uFED6','\uFED7','\uFED8'],
  'ك':['\uFED9','\uFEDA','\uFEDB','\uFEDC'], 'ل':['\uFEDD','\uFEDE','\uFEDF','\uFEE0'], 'م':['\uFEE1','\uFEE2','\uFEE3','\uFEE4'], 'ن':['\uFEE5','\uFEE6','\uFEE7','\uFEE8'],
  'ه':['\uFEE9','\uFEEA','\uFEEB','\uFEEC'], 'و':['\uFEED','\uFEEE'], 'ى':['\uFEEF','\uFEF0'], 'ي':['\uFEF1','\uFEF2','\uFEF3','\uFEF4']
};
const dual = new Set(Object.entries(forms).filter(([, value]) => value.length === 4).map(([key]) => key));
const joinsRight = new Set(Object.keys(forms));
const arabic = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;

function shapeWord(word) {
  const chars = [...word];
  const shaped = chars.map((char, index) => {
    const options = forms[char];
    if (!options) return char;
    const previous = chars[index - 1];
    const next = chars[index + 1];
    const joinPrevious = Boolean(previous && dual.has(previous) && joinsRight.has(char));
    const joinNext = Boolean(next && dual.has(char) && joinsRight.has(next));
    const formIndex = joinPrevious && joinNext ? 3 : joinPrevious ? Math.min(1, options.length - 1) : joinNext ? Math.min(2, options.length - 1) : 0;
    return options[formIndex];
  });
  return shaped.reverse().join('');
}

export function shapeArabicForRoku(value) {
  const shaped = String(value || '').split(/(\s+)/).map(token => arabic.test(token) ? shapeWord(token) : token).reverse().join('');
  return shaped.length > 68 ? `${shaped.slice(0, 65)}...` : shaped;
}
