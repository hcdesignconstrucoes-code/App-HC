// Vercel Serverless Function: lê um orçamento (PDF, foto ou folha de Excel em texto) e devolve capítulos e trabalhos em JSON.
// Usa as mesmas variáveis do ler-fatura.js: ANTHROPIC_API_KEY (obrigatória), SUPABASE_URL e SUPABASE_ANON_KEY (recomendadas).
// ORC_MODEL (opcional) — por omissão claude-haiku-5-5 (rápido, para caber no tempo do Vercel).

async function userOk(token) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return true;
  if (!token) return false;
  try { const r = await fetch(url.replace(/\/$/, '') + '/auth/v1/user', { headers: { Authorization: 'Bearer ' + token, apikey: key } }); return r.ok; } catch (e) { return false; }
}

const prompt = (caps, espacos) => `És orçamentista de uma empresa de remodelações e construção em Portugal.
Lê este orçamento / mapa de trabalhos e quantidades e responde APENAS com um objeto JSON, sem texto à volta:
{
 "nome": "nome curto do orçamento ou da obra",
 "cliente": "nome do cliente ou null",
 "morada": "morada da obra ou null",
 "descricao": "descrição geral curta da obra ou null",
 "capitulos": [
  { "nome": "nome do capítulo",
    "itens": [ { "descricao": "texto COMPLETO do trabalho, sem resumir",
                 "espaco": "espaço/divisão (ex.: Casas de Banho, Cozinhas, Geral) ou null",
                 "unidade": "UN, M2, M3, ML, KG, L ou VG",
                 "quantidade": número,
                 "preco_unitario": preço de venda por unidade SEM IVA,
                 "total": total da linha SEM IVA,
                 "custo_material": custo de material por unidade só se o documento o indicar à parte, senão null,
                 "custo_mao_obra": custo de mão-de-obra por unidade só se o documento o indicar à parte, senão null } ] } ],
 "notas": "notas / condições escritas no orçamento ou null"
}
Regras: mantém a ordem e os capítulos do documento; se não houver capítulos, agrupa por tipo de trabalho.
Quando um capítulo corresponder a um destes, usa exatamente este nome: ${caps.join(', ')}.
Para "espaco", usa de preferência um destes: ${espacos.join(', ')}.
Números com ponto decimal e sem €. Ignora subtotais, totais gerais e linhas de IVA (não são trabalhos).
Se não for um orçamento, devolve {"erro":"não parece um orçamento"}.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ erro: 'Falta a variável ANTHROPIC_API_KEY no Vercel.' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!(await userOk(token))) return res.status(401).json({ erro: 'Sessão inválida. Entra de novo na app.' });

  const { data, type, text, nome, caps, espacos } = req.body || {};
  const C = Array.isArray(caps) ? caps.slice(0, 40).map(c => String(c).slice(0, 60)) : [];
  const E = Array.isArray(espacos) ? espacos.slice(0, 40).map(c => String(c).slice(0, 60)) : [];
  let blocks;
  if (typeof text === 'string' && text.trim()) {
    blocks = [{ type: 'text', text: 'Conteúdo da folha de cálculo "' + String(nome || '').slice(0, 80) + '" (CSV, separador ;):\n\n' + text.slice(0, 180000) }];
  } else if (data && type) {
    if (/pdf/i.test(type)) blocks = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }];
    else if (/^image\/(jpeg|png|gif|webp)$/i.test(type)) blocks = [{ type: 'image', source: { type: 'base64', media_type: type.toLowerCase(), data } }];
    else return res.status(400).json({ erro: 'Formato não suportado (usa PDF, Excel, CSV ou foto).' });
  } else return res.status(400).json({ erro: 'Ficheiro em falta.' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ORC_MODEL || 'claude-haiku-5-5', max_tokens: 16000, messages: [{ role: 'user', content: [...blocks, { type: 'text', text: prompt(C, E) }] }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ erro: (j && j.error && j.error.message) || 'Erro na API' });
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ erro: 'Resposta inesperada ao ler o orçamento.' });
    let out; try { out = JSON.parse(m[0]); } catch (e) { return res.status(502).json({ erro: j.stop_reason === 'max_tokens' ? 'O orçamento é demasiado grande para ler de uma vez. Divide-o em partes.' : 'Não foi possível interpretar a resposta.' }); }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ erro: 'Não foi possível ler o orçamento: ' + (e && e.message) });
  }
};
