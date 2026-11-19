// Vercel Serverless Function: lê uma fatura (foto ou PDF) com o Claude e devolve os campos em JSON.
// Variáveis de ambiente no Vercel:
//   ANTHROPIC_API_KEY  (obrigatória)  – chave da API em console.anthropic.com
//   SUPABASE_URL, SUPABASE_ANON_KEY  (recomendadas) – só utilizadores com sessão iniciada podem usar
//   CLAUDE_MODEL       (opcional)     – por omissão claude-sonnet-5-5

const CATS = ['Alvenaria', 'Elétrico', 'Canalização', 'Acabamentos', 'Outros'];

const PROMPT = `És um assistente de contabilidade de uma empresa de construção em Portugal.
Lê esta fatura e responde APENAS com um objeto JSON, sem texto à volta, neste formato:
{
 "fornecedor": "nome da empresa que emitiu a fatura",
 "nif_fornecedor": "NIF do fornecedor ou null",
 "numero": "número da fatura, ex.: FT 2026/123",
 "data": "AAAA-MM-DD (data de emissão)",
 "artigo": "descrição curta (até 80 caracteres) do que foi comprado",
 "liquido": número total sem IVA (incidência),
 "iva_valor": número total do IVA,
 "iva_pct": taxa de IVA em % (se houver várias taxas, a média ponderada = iva_valor/liquido*100),
 "total": número total a pagar com IVA,
 "categoria": uma de ${JSON.stringify(CATS)} conforme o tipo de material
}
Números com ponto decimal e sem símbolo €. Usa null no que não conseguires ler.
Se não for uma fatura, devolve {"erro":"não é uma fatura"}.`;

async function userOk(token) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return true; // sem Supabase configurado no servidor, não verifica
  if (!token) return false;
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/auth/v1/user', { headers: { Authorization: 'Bearer ' + token, apikey: key } });
    return r.ok;
  } catch (e) { return false; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ erro: 'Falta a variável ANTHROPIC_API_KEY no Vercel.' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!(await userOk(token))) return res.status(401).json({ erro: 'Sessão inválida. Entra de novo na app.' });

  const { data, type } = req.body || {};
  if (!data || !type) return res.status(400).json({ erro: 'Ficheiro em falta.' });
  const isPdf = /pdf/i.test(type);
  const isImg = /^image\/(jpeg|png|gif|webp)$/i.test(type);
  if (!isPdf && !isImg) return res.status(400).json({ erro: 'Formato não suportado (usa JPG, PNG, WEBP ou PDF).' });

  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: type.toLowerCase(), data } };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }]
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ erro: (j && j.error && j.error.message) || 'Erro na API' });
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ erro: 'Resposta inesperada ao ler a fatura.' });
    const out = JSON.parse(m[0]);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ erro: 'Não foi possível ler a fatura: ' + (e && e.message) });
  }
};
