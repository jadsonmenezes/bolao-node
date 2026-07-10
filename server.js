const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const xlsx = require('xlsx');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.set('view engine', 'ejs');
app.set('views', './views');
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Middleware de autenticação
app.use((req, res, next) => {
    res.locals.isAdmin = false;
    res.locals.usuarioLogado = null;
    if (req.cookies.auth_token) {
        res.locals.isAdmin = true;
        res.locals.usuarioLogado = req.cookies.auth_token;
    }
    next();
});

// CONEXÃO COM O SUPABASE
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres.tokeibtjwekopmdftfqb:zbMVCNrivne3D9LW@aws-1-sa-east-1.pooler.supabase.com:5432/postgres';

const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
});

// INICIALIZAÇÃO DO BANCO DE DADOS
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS edicoes (
            id SERIAL PRIMARY KEY, nome_bolao TEXT, numero INTEGER, data_inicio TEXT, 
            valor_aposta REAL, pct_admin REAL, pct_premio_principal REAL, pct_primeiro_sorteio REAL, 
            pct_proximos REAL, pct_doacao REAL, mostrar_admin BOOLEAN, status TEXT,
            tipo_bolao TEXT DEFAULT 'acumulativo', qtd_dezenas INTEGER DEFAULT 6,
            deletado_em TIMESTAMP DEFAULT NULL
        )`);

        await client.query(`ALTER TABLE edicoes ADD COLUMN IF NOT EXISTS deletado_em TIMESTAMP DEFAULT NULL`);
        
        await client.query(`CREATE TABLE IF NOT EXISTS apostas (
            id SERIAL PRIMARY KEY, edicao_id INTEGER, cartao INTEGER DEFAULT 0, 
            nome TEXT, dezenas TEXT, is_bonus BOOLEAN, pago BOOLEAN DEFAULT false, acertos INTEGER DEFAULT 0, 
            tem_erro INTEGER DEFAULT 0
        )`);
        
        await client.query(`CREATE TABLE IF NOT EXISTS sorteios (
            id SERIAL PRIMARY KEY, edicao_id INTEGER, concurso INTEGER, dezenas TEXT, 
            data_lancamento TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await client.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY, username TEXT UNIQUE, senha TEXT
        )`);
        
        const userRes = await client.query("SELECT id FROM usuarios WHERE username = 'admin'");
        if (userRes.rows.length === 0) {
            await client.query("INSERT INTO usuarios (username, senha) VALUES ('admin', 'beap@154')");
        }

        const res = await client.query("SELECT id FROM edicoes WHERE deletado_em IS NULL LIMIT 1");
        if (res.rows.length === 0) {
            await client.query("INSERT INTO edicoes (nome_bolao, numero, data_inicio, valor_aposta, pct_admin, pct_premio_principal, pct_primeiro_sorteio, pct_proximos, pct_doacao, mostrar_admin, status, tipo_bolao, qtd_dezenas) VALUES ('Bolão Entre Amigos', 1, to_char(NOW(), 'YYYY-MM-DD'), 20.00, 15, 75, 7, 15, 3, true, 'aberta', 'acumulativo', 6)");
        }
    } finally {
        client.release();
    }
}
initDB().catch(err => console.error('Erro ao inicializar banco:', err));

// FUNÇÃO CORRIGIDA: Captura edicao_id via query (GET) ou body (POST)
async function getContextoEdicao(req, callback) {
    try {
        await pool.query("DELETE FROM edicoes WHERE deletado_em < NOW() - INTERVAL '3 days'");

        const todasEdicoesRes = await pool.query("SELECT id, numero, nome_bolao, tipo_bolao FROM edicoes WHERE deletado_em IS NULL ORDER BY numero DESC");
        
        let edicaoId_selecionada = req.query.edicao_id || req.body.edicao_id;
        let edicaoRes;
        
        if (edicaoId_selecionada) {
            edicaoRes = await pool.query("SELECT * FROM edicoes WHERE id = $1 AND deletado_em IS NULL", [edicaoId_selecionada]);
        } else {
            edicaoRes = await pool.query("SELECT * FROM edicoes WHERE deletado_em IS NULL ORDER BY id DESC LIMIT 1");
        }
        
        const todasEdicoes = todasEdicoesRes.rows;
        const edicao = edicaoRes.rows[0];

        if (!edicao) {
            return callback(null, { 
                edicao: { id: 0, nome_bolao: 'Nenhum Bolão Ativo', numero: 0, data_inicio: '-', valor_aposta: 0, pct_admin: 0, pct_premio_principal: 0, pct_primeiro_sorteio: 0, pct_proximos: 0, pct_doacao: 0, mostrar_admin: false, status: 'finalizada', tipo_bolao: 'acumulativo', qtd_dezenas: 6 }, 
                todasEdicoes: [], 
                linkParams: '' 
            });
        }
        callback(null, { edicao, todasEdicoes, linkParams: `?edicao_id=${edicao.id}` });
    } catch (err) {
        callback(err, null);
    }
}

function checkAdmin(req, res, next) { if (!res.locals.isAdmin) return res.redirect('/login'); next(); }

// RANKING PÚBLICO
app.get('/', (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        if (!ctx || ctx.edicao.id === 0) return res.send("Nenhuma edição ativa encontrada.");
        try {
            const apostasRows = (await pool.query(`SELECT * FROM apostas WHERE edicao_id = $1 ORDER BY cartao ASC, nome ASC`, [ctx.edicao.id])).rows;
            const sorteiosRows = (await pool.query(`SELECT * FROM sorteios WHERE edicao_id = $1 ORDER BY data_lancamento ASC`, [ctx.edicao.id])).rows;
            
            const apostas = apostasRows || [];
            const sorteios = (sorteiosRows || []).map(s => ({ ...s, dezenas: JSON.parse(s.dezenas) }));
            let todasDezenas = []; sorteios.forEach(s => todasDezenas = todasDezenas.concat(s.dezenas));
            let dezenasPrimeiroSorteio = sorteios.length > 0 ? sorteios[0].dezenas : [];

            const pagas = apostas.filter(a => !a.is_bonus && a.pago).length;
            const arrecadacaoAtual = pagas * ctx.edicao.valor_aposta;
            const adminValor = arrecadacaoAtual * (ctx.edicao.pct_admin / 100);
            const fundoPremio = arrecadacaoAtual - adminValor;

            let maxPriSorteio = 0, temSena = false, maxRateio = 0;

            let ranking = apostas.map(a => {
                const dezenas = JSON.parse(a.dezenas);
                let accTot = 0, accPri = 0;
                dezenas.forEach(d => {
                    if (todasDezenas.includes(d)) accTot++;
                    if (dezenasPrimeiroSorteio.includes(d)) accPri++;
                });
                if (accPri > maxPriSorteio) maxPriSorteio = accPri;
                if (ctx.edicao.tipo_bolao === 'acumulativo' && accTot === ctx.edicao.qtd_dezenas) temSena = true;
                return { ...a, dezenas, accTot, accPri, premios: [], valorTotalPremio: 0 };
            });

            if (ctx.edicao.tipo_bolao === 'acumulativo') {
                if (temSena) ranking.forEach(r => { if (r.accTot < ctx.edicao.qtd_dezenas && r.accTot > maxRateio) maxRateio = r.accTot; });

                if (sorteios.length > 0 && ctx.edicao.pct_primeiro_sorteio > 0) {
                    const gPri = ranking.filter(r => r.accPri === maxPriSorteio);
                    gPri.forEach(g => {
                        let v = (fundoPremio * (ctx.edicao.pct_primeiro_sorteio / 100)) / gPri.length;
                        g.premios.push({ nome: '1º Sorteio', valor: v }); g.valorTotalPremio += v;
                    });
                }
                if (temSena) {
                    const gSena = ranking.filter(r => r.accTot === ctx.edicao.qtd_dezenas);
                    gSena.forEach(g => {
                        let v = (fundoPremio * (ctx.edicao.pct_premio_principal / 100)) / gSena.length;
                        g.premios.push({ nome: 'Prêmio Principal', valor: v }); g.valorTotalPremio += v;
                    });
                    const gRateio = ranking.filter(r => r.accTot === maxRateio);
                    gRateio.forEach(g => {
                        let v = (fundoPremio * (ctx.edicao.pct_proximos / 100)) / gRateio.length;
                        g.premios.push({ nome: `Rateio (${maxRateio} pts)`, valor: v }); g.valorTotalPremio += v;
                    });
                }
            } else {
                if (sorteios.length > 0 && ranking.length > 0) {
                    let maiorPontuacao = Math.max(...ranking.map(r => r.accTot));
                    let segundaMaiorPontuacao = Math.max(...ranking.filter(r => r.accTot < maiorPontuacao).map(r => r.accTot), 0);

                    const gPrincipal = ranking.filter(r => r.accTot === maiorPontuacao);
                    gPrincipal.forEach(g => {
                        let v = (fundoPremio * (ctx.edicao.pct_premio_principal / 100)) / gPrincipal.length;
                        g.premios.push({ nome: `Campeão (${maiorPontuacao} Pts)`, valor: v }); g.valorTotalPremio += v;
                    });

                    if (segundaMaiorPontuacao > 0 && ctx.edicao.pct_proximos > 0) {
                        const gProximos = ranking.filter(r => r.accTot === segundaMaiorPontuacao);
                        gProximos.forEach(g => {
                            let v = (fundoPremio * (ctx.edicao.pct_proximos / 100)) / gProximos.length;
                            g.premios.push({ nome: `Vice-Campeão (${segundaMaiorPontuacao} Pts)`, valor: v }); g.valorTotalPremio += v;
                        });
                    }
                }
            }

            ranking.sort((a, b) => {
                if (b.accTot !== a.accTot) return b.accTot - a.accTot;
                return a.cartao - b.cartao;
            });

            res.render('index', { ranking, sorteios, todasDezenas, edicao: ctx.edicao, todasEdicoes: ctx.todasEdicoes, linkParams: ctx.linkParams, stats: { total: apostas.length, pagos: pagas, bonus: apostas.filter(a => a.is_bonus).length, arrecadacaoAtual, adminValor, fundoPremio, temSena: (ctx.edicao.tipo_bolao === 'tiro_curto' ? sorteios.length > 0 : temSena) } });
        } catch (e) { res.status(500).send(e.toString()); }
    });
});

app.get('/login', (req, res) => res.render('login', { erro: false }));
app.post('/login', async (req, res) => {
    const { username, senha } = req.body;
    try {
        const result = await pool.query("SELECT * FROM usuarios WHERE username = $1 AND senha = $2", [username.trim(), senha.trim()]);
        if (result.rows.length > 0) {
            res.cookie('auth_token', result.rows[0].username, { maxAge: 86400000 }); 
            res.redirect('/apostas');
        } else {
            res.render('login', { erro: true });
        }
    } catch (e) { res.status(500).send(e.toString()); }
});
app.get('/logout', (req, res) => { res.clearCookie('auth_token'); res.redirect('/'); });

// ADMIN - USUARIOS
app.get('/usuarios', checkAdmin, async (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        try {
            const users = (await pool.query("SELECT id, username FROM usuarios ORDER BY username ASC")).rows;
            res.render('usuarios', { users, edicao: ctx.edicao, todasEdicoes: ctx.todasEdicoes, linkParams: ctx.linkParams });
        } catch (e) { res.status(500).send(e.toString()); }
    });
});

app.post('/usuarios/salvar', checkAdmin, async (req, res) => {
    const { username, senha } = req.body;
    try {
        await pool.query("INSERT INTO usuarios (username, senha) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET senha = $2", [username.trim(), senha.trim()]);
        res.redirect('/usuarios');
    } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/usuarios/deletar/:id', checkAdmin, async (req, res) => {
    try {
        const user = (await pool.query("SELECT username FROM usuarios WHERE id = $1", [req.params.id])).rows[0];
        if (user && user.username === 'admin') {
            return res.send("<script>alert('O utilizador master admin não pode ser eliminado.'); window.location='/usuarios';</script>");
        }
        await pool.query("DELETE FROM usuarios WHERE id = $1", [req.params.id]);
        res.redirect('/usuarios');
    } catch (e) { res.status(500).send(e.toString()); }
});

// ADMIN - APOSTAS
app.get('/apostas', checkAdmin, (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        try {
            const rows = (await pool.query(`SELECT * FROM apostas WHERE edicao_id = $1 ORDER BY cartao ASC, nome ASC`, [ctx.edicao.id])).rows;
            const apostas = (rows || []).map(r => ({ ...r, dezenas: JSON.parse(r.dezenas) }));
            const srt = (await pool.query(`SELECT COUNT(*) as count FROM sorteios WHERE edicao_id = $1`, [ctx.edicao.id])).rows[0];
            
            let edicaoTravada = srt ? parseInt(srt.count) > 0 : false;
            let possuiSena = ctx.edicao.tipo_bolao === 'acumulativo' && apostas.some(a => a.acertos >= ctx.edicao.qtd_dezenas);
            
            const normais = apostas.filter(a => !a.is_bonus);
            const pagas = normais.filter(a => a.pago).length;
            res.render('apostas', { apostas, edicaoTravada: (edicaoTravada || possuiSena || ctx.edicao.status === 'finalizada'), edicao: ctx.edicao, todasEdicoes: ctx.todasEdicoes, linkParams: ctx.linkParams, stats: { total: apostas.length, pagas, pendentes: normais.length - pagas, bonus: apostas.filter(a => a.is_bonus).length, previsto: normais.length * ctx.edicao.valor_aposta, arrecadado: pagas * ctx.edicao.valor_aposta } });
        } catch (e) { res.status(500).send(e.toString()); }
    });
});

app.post('/apostas/salvar', checkAdmin, (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        const { id, nome, dezenas, is_bonus, pago } = req.body;
        const arrDezenas = dezenas.split(',').map(Number).sort((a, b) => a - b);
        const bChecked = is_bonus === 'on';
        const pChecked = pago === 'on' || bChecked;
        let baseName = nome.trim();

        try {
            const rows = (await pool.query(`SELECT id, nome FROM apostas WHERE edicao_id = $1 AND nome LIKE $2`, [ctx.edicao.id, baseName + '%'])).rows;
            let finalName = baseName; let count = 1;
            const existingNames = rows.filter(r => r.id != id).map(r => r.nome.toLowerCase());
            while (existingNames.includes(finalName.toLowerCase())) { count++; finalName = `${baseName} ${count}`; }

            if (id) {
                await pool.query(`UPDATE apostas SET nome=$1, dezenas=$2, is_bonus=$3, pago=$4, tem_erro=0 WHERE id=$5`, [finalName, JSON.stringify(arrDezenas), bChecked, pChecked, id]);
            } else {
                await pool.query(`INSERT INTO apostas (edicao_id, nome, dezenas, is_bonus, pago, tem_erro) VALUES ($1, $2, $3, $4, $5, 0)`, [ctx.edicao.id, finalName, JSON.stringify(arrDezenas), bChecked, pChecked]);
            }
            res.redirect(`/apostas?edicao_id=${ctx.edicao.id}`);
        } catch (e) { res.status(500).send(e.toString()); }
    });
});

app.post('/apostas/limpar-tudo', checkAdmin, (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        if (ctx.edicao.id === 0) return res.redirect('/apostas');
        try {
            await pool.query("DELETE FROM apostas WHERE edicao_id = $1", [ctx.edicao.id]);
            res.redirect(`/apostas?edicao_id=${ctx.edicao.id}`);
        } catch (e) { res.status(500).send(e.toString()); }
    });
});

app.post('/apostas/toggle-pago/:id', checkAdmin, (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        await pool.query(`UPDATE apostas SET pago = NOT pago WHERE id = $1`, [req.params.id]);
        res.redirect(`/apostas?edicao_id=${ctx.edicao.id}`);
    });
});

app.post('/apostas/deletar/:id', checkAdmin, (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        await pool.query(`DELETE FROM apostas WHERE id = $1`, [req.params.id]);
        res.redirect(`/apostas?edicao_id=${ctx.edicao.id}`);
    });
});

// ADMIN - EDICOES
app.get('/edicoes', checkAdmin, (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        try {
            const edicoes = (await pool.query("SELECT * FROM edicoes WHERE deletado_em IS NULL ORDER BY numero DESC")).rows;
            const lixeira = (await pool.query("SELECT * FROM edicoes WHERE deletado_em IS NOT NULL AND deletado_em >= NOW() - INTERVAL '3 days' ORDER BY deletado_em DESC")).rows;
            
            const rows = (await pool.query("SELECT pago, is_bonus FROM apostas WHERE edicao_id = $1", [ctx.edicao.id])).rows;
            
            const total = rows ? rows.length : 0;
            const bonus = rows ? rows.filter(r => r.is_bonus).length : 0;
            const pagas = rows ? rows.filter(r => !r.is_bonus && r.pago).length : 0;
            const arrecadado = pagas * ctx.edicao.valor_aposta;
            
            const stats = { total, pagas, pendentes: (total - bonus) - pagas, bonus, arrecadado, previsto: (total - bonus) * ctx.edicao.valor_aposta };
            res.render('edicoes', { edicoes: edicoes || [], lixeira: lixeira || [], edicao: ctx.edicao, todasEdicoes: ctx.todasEdicoes, linkParams: ctx.linkParams, stats });
        } catch (e) { res.status(500).send(e.toString()); }
    });
});

app.post('/edicoes/salvar', checkAdmin, async (req, res) => {
    const { id, nome_bolao, data_inicio, valor_aposta, pct_admin, pct_premio_principal, pct_primeiro_sorteio, pct_proximos, pct_doacao, mostrar_admin, clonar_jogos_id, tipo_bolao, qtd_dezenas } = req.body;
    const mAdmin = mostrar_admin === 'on';
    const numDezenas = parseInt(qtd_dezenas) || 6;
    const tipo = tipo_bolao || 'acumulativo';
    
    try {
        if (id && id !== '0') {
            await pool.query(`UPDATE edicoes SET nome_bolao=$1, data_inicio=$2, valor_aposta=$3, pct_admin=$4, pct_premio_principal=$5, pct_primeiro_sorteio=$6, pct_proximos=$7, pct_doacao=$8, mostrar_admin=$9, tipo_bolao=$10, qtd_dezenas=$11 WHERE id=$12`, [nome_bolao, data_inicio, valor_aposta, pct_admin, pct_premio_principal, pct_primeiro_sorteio, pct_proximos, pct_doacao, mAdmin, tipo, numDezenas, id]);
            res.redirect(`/edicoes?edicao_id=${id}`);
        } else {
            const ult = (await pool.query("SELECT * FROM edicoes WHERE deletado_em IS NULL ORDER BY id DESC LIMIT 1")).rows[0];
            const proximoNumero = ult ? ult.numero + 1 : 1;
            
            const insertRes = await pool.query(`INSERT INTO edicoes (nome_bolao, numero, data_inicio, valor_aposta, pct_admin, pct_premio_principal, pct_primeiro_sorteio, pct_proximos, pct_doacao, mostrar_admin, status, tipo_bolao, qtd_dezenas) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'aberta', $11, $12) RETURNING id`, [nome_bolao, proximoNumero, data_inicio, valor_aposta, pct_admin, pct_premio_principal, pct_primeiro_sorteio, pct_proximos, pct_doacao, mAdmin, tipo, numDezenas]);
            const novaEdicaoId = insertRes.rows[0].id;
            
            if (clonar_jogos_id && clonar_jogos_id !== 'nao') {
                const apostasAnteriores = (await pool.query("SELECT nome, dezenas, is_bonus, pago FROM apostas WHERE edicao_id = $1", [clonar_jogos_id])).rows;
                for (const ap of apostasAnteriores) {
                    let dezenasArray = JSON.parse(ap.dezenas);
                    if (dezenasArray.length < numDezenas) {
                        while(dezenasArray.length < numDezenas) dezenasArray.push(0);
                    } else if (dezenasArray.length > numDezenas) {
                        dezenasArray = dezenasArray.slice(0, numDezenas);
                    }
                    await pool.query(`INSERT INTO apostas (edicao_id, nome, dezenas, is_bonus, pago, acertos, tem_erro) VALUES ($1, $2, $3, $4, $5, 0, 0)`, [novaEdicaoId, ap.nome, JSON.stringify(dezenasArray), ap.is_bonus, ap.pago]);
                }
            }
            res.redirect(`/edicoes?edicao_id=${novaEdicaoId}`);
        }
    } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/edicoes/deletar/:id', checkAdmin, async (req, res) => {
    const edicaoId = req.params.id;
    try {
        await pool.query("UPDATE edicoes SET deletado_em = NOW() WHERE id = $1", [edicaoId]);
        res.redirect('/edicoes');
    } catch (e) { res.status(500).send(e.toString()); }
});

app.post('/edicoes/restaurar/:id', checkAdmin, async (req, res) => {
    const edicaoId = req.params.id;
    try {
        await pool.query("UPDATE edicoes SET deletado_em = NULL WHERE id = $1", [edicaoId]);
        res.redirect(`/edicoes?edicao_id=${edicaoId}`);
    } catch (e) { res.status(500).send(e.toString()); }
});

// IMPORTADOR DINÂMICO
app.post('/edicoes/importar', checkAdmin, upload.single('planilha'), (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        if (!req.file || ctx.edicao.id === 0) return res.redirect(`/apostas?edicao_id=${ctx.edicao.id}`);
        
        const limiteDezenas = parseInt(ctx.edicao.qtd_dezenas) || 6; 
        try {
            const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
            const data = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });

            for (let rIdx = 0; rIdx < data.length; rIdx++) {
                const row = data[rIdx];
                if (!row || row.length < 3) continue;

                let colA = String(row[0] || '').trim();
                let numSequencial = parseInt(colA);
                if (isNaN(numSequencial)) continue;

                let nomeRaw = row[1] ? String(row[1]).trim() : "";
                let upperNome = nomeRaw.toUpperCase();
                if (nomeRaw === "" || upperNome === "NOME") continue;

                let dezenasBrutas = [];
                let isBonus = false;
                let estaPago = false;
                let possuiErroDigitacao = 0;

                for (let col = 2; col < (2 + limiteDezenas); col++) {
                    let cellVal = row[col];
                    if (cellVal === undefined || cellVal === null || String(cellVal).trim() === "") {
                        possuiErroDigitacao = 1;
                        dezenasBrutas.push(0);
                        continue;
                    }
                    let strCell = String(cellVal).trim();
                    let num = parseInt(strCell.replace(/[^\d]/g, ''));
                    if (!isNaN(num) && num >= 1 && num <= 60) {
                        dezenasBrutas.push(num);
                    } else {
                        possuiErroDigitacao = 1;
                        dezenasBrutas.push(0);
                    }
                }

                for (let i = (2 + limiteDezenas); i < row.length; i++) {
                    if (row[i] === undefined || row[i] === null) continue;
                    let strStatus = String(row[i]).toUpperCase().trim();
                    if (strStatus.includes("BÔNUS") || strStatus.includes("BONUS")) {
                        isBonus = true;
                    }
                    if (strStatus === "SIM" || strStatus === "PAGO") {
                        estaPago = true;
                    }
                }

                if (isBonus) estaPago = true;

                let dezenasValidas = dezenasBrutas.filter(n => n > 0);
                let dezenasUnicas = [...new Set(dezenasValidas)];
                if (dezenasUnicas.length !== dezenasValidas.length || dezenasValidas.length !== limiteDezenas) {
                    possuiErroDigitacao = 1;
                }

                while (dezenasBrutas.length < limiteDezenas) { dezenasBrutas.push(0); }
                dezenasBrutas.sort((a, b) => a - b);

                await pool.query(`INSERT INTO apostas (edicao_id, nome, dezenas, is_bonus, pago, acertos, tem_erro) VALUES ($1, $2, $3, $4, $5, 0, $6)`, 
                    [ctx.edicao.id, nomeRaw, JSON.stringify(dezenasBrutas), isBonus, estaPago, possuiErroDigitacao]
                );
            }
            res.redirect(`/apostas?edicao_id=${ctx.edicao.id}`);
        } catch (e) { res.status(500).send(e.toString()); }
    });
});

// ADMIN - SORTEIOS
app.get('/sorteios', checkAdmin, (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        try {
            const sorteiosRows = (await pool.query(`SELECT * FROM sorteios WHERE edicao_id = $1 ORDER BY concurso DESC`, [ctx.edicao.id])).rows;
            const sorteios = (sorteiosRows || []).map(s => ({ ...s, dezenas: JSON.parse(s.dezenas) }));
            const apInfo = (await pool.query(`SELECT MAX(acertos) as max_acertos FROM apostas WHERE edicao_id = $1`, [ctx.edicao.id])).rows[0];
            
            let temSena = ctx.edicao.tipo_bolao === 'acumulativo' && apInfo && apInfo.max_acertos >= ctx.edicao.qtd_dezenas;
            let tiroCurtoFinalizado = ctx.edicao.tipo_bolao === 'tiro_curto' && sorteios.length >= 1;

            if ((temSena || tiroCurtoFinalizado) && ctx.edicao.status !== 'finalizada') {
                await pool.query("UPDATE edicoes SET status = 'finalizada' WHERE id = $1", [ctx.edicao.id]);
                ctx.edicao.status = 'finalizada';
            }
            
            const apRows = (await pool.query("SELECT pago, is_bonus FROM apostas WHERE edicao_id = $1", [ctx.edicao.id])).rows;
            const total = apRows ? apRows.length : 0;
            const bonus = apRows ? apRows.filter(r => r.is_bonus).length : 0;
            const pagas = apRows ? apRows.filter(r => !r.is_bonus && r.pago).length : 0;
            
            const stats = { total, pagas, pendentes: (total - bonus) - pagas, bonus, arrecadado: pagas * ctx.edicao.valor_aposta };
            res.render('sorteios', { sorteios, temSena: (temSena || tiroCurtoFinalizado || ctx.edicao.status === 'finalizada'), edicao: ctx.edicao, todasEdicoes: ctx.todasEdicoes, linkParams: ctx.linkParams, stats });
        } catch (e) { res.status(500).send(e.toString()); }
    });
});

app.post('/sorteios/novo', checkAdmin, async (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        if (ctx.edicao.status === 'finalizada') return res.redirect(`/sorteios?edicao_id=${ctx.edicao.id}`);
        
        const arr = req.body.dezenas.split(',').map(Number).sort((a,b) => a - b);
        try {
            const srt = (await pool.query(`SELECT COUNT(*) as count FROM sorteios WHERE edicao_id = $1`, [ctx.edicao.id])).rows[0];
            if (srt && parseInt(srt.count) === 0) {
                const aps = (await pool.query(`SELECT id FROM apostas WHERE edicao_id = $1 ORDER BY nome ASC`, [ctx.edicao.id])).rows;
                let idx = 1;
                for (const ap of aps) {
                    await pool.query(`UPDATE apostas SET cartao = $1 WHERE id = $2`, [idx++, ap.id]);
                }
            }
            
            await pool.query(`INSERT INTO sorteios (edicao_id, concurso, dezenas) VALUES ($1, $2, $3)`, [ctx.edicao.id, req.body.concurso, JSON.stringify(arr)]);
            
            const allApostas = (await pool.query(`SELECT id, dezenas FROM apostas WHERE edicao_id = $1`, [ctx.edicao.id])).rows;
            const allSorteios = (await pool.query(`SELECT dezenas FROM sorteios WHERE edicao_id = $1`, [ctx.edicao.id])).rows;
            let drawnNumbers = [];
            allSorteios.forEach(s => drawnNumbers = drawnNumbers.concat(JSON.parse(s.dezenas)));
            
            for (const ap of allApostas) {
                let currentDezenas = JSON.parse(ap.dezenas);
                let hits = currentDezenas.filter(n => drawnNumbers.includes(n)).length;
                await pool.query(`UPDATE apostas SET acertos = $1 WHERE id = $2`, [hits, ap.id]);
            }

            if (ctx.edicao.tipo_bolao === 'tiro_curto') {
                await pool.query("UPDATE edicoes SET status = 'finalizada' WHERE id = $1", [ctx.edicao.id]);
            }
            
            res.redirect(`/sorteios?edicao_id=${ctx.edicao.id}`);
        } catch (e) { res.status(500).send(e.toString()); }
    });
});

app.post('/sorteios/deletar/:id', checkAdmin, async (req, res) => {
    getContextoEdicao(req, async (err, ctx) => {
        await pool.query(`DELETE FROM sorteios WHERE id = $1`, [req.params.id]);
        await pool.query("UPDATE edicoes SET status = 'aberta' WHERE id = $1", [ctx.edicao.id]);
        res.redirect(`/sorteios?edicao_id=${ctx.edicao.id}`);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Plataforma Online ativa na porta ${PORT}`));
