function normalizeKeys(value) {
  return [...new Set((Array.isArray(value) ? value : [value]).flatMap(item => String(item || '').split(/[\s,;]+/)).map(key => key.trim()).filter(Boolean))];
}

function keyError(error) {
  return error.status === 401 || error.status === 403 || error.status === 429 ||
    (error.status === 400 && /API_KEY_INVALID|API key|api_key|key expired/i.test(`${error.message} ${JSON.stringify(error.details || [])}`));
}

class GeminiKeyRing {
  constructor(keys, { start = 0, status = () => {} } = {}) {
    this.keys = normalizeKeys(keys); this.cursor = this.keys.length ? start % this.keys.length : 0;
    this.disabled = new Set(); this.cooldown = new Map(); this.status = status;
  }
  async call(send) {
    let last, earliest;
    for (let offset = 0, start = this.cursor; offset < this.keys.length; offset++) {
      const index = (start + offset) % this.keys.length;
      if (this.disabled.has(index)) continue;
      const cooling = this.cooldown.get(index);
      if (cooling?.until > Date.now()) { if (!earliest || cooling.until < earliest.until) earliest = cooling; continue; }
      try { const result = await send(this.keys[index]); this.cursor = index; return result; }
      catch (error) {
        if (!keyError(error)) throw error;
        last = error;
        const daily = error.status === 429 && (error.details || []).flatMap(d => d.violations || []).some(v => /PerDay/i.test(v.quotaId || ''));
        if (error.status === 429 && !daily) {
          const delay = Number(String((error.details || []).find(d => d.retryDelay)?.retryDelay || '').replace(/s$/, '')) || 3;
          const entry = { until: Date.now() + delay * 1000, error };
          this.cooldown.set(index, entry); if (!earliest || entry.until < earliest.until) earliest = entry;
        } else this.disabled.add(index);
        this.cursor = (index + 1) % this.keys.length;
        this.status(`Gemini 키 ${index + 1}/${this.keys.length} · HTTP ${error.status}, 다른 키를 확인하고 있어요`);
      }
    }
    if (earliest && (!last || last.status === 429)) {
      const error = new Error('등록한 Gemini 키가 모두 요청 제한 상태입니다. 잠시 기다린 뒤 재시도합니다.');
      error.status = 429; error.details = [{ retryDelay: `${Math.max(1, Math.ceil((earliest.until - Date.now()) / 1000))}s` }];
      throw error;
    }
    throw last || Object.assign(new Error('사용 가능한 Gemini API 키가 없습니다.'), { status: 401 });
  }
}
module.exports = { GeminiKeyRing, normalizeKeys };
