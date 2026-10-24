const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000; // const PORT = 3000
const OVERRIDE_FILE = path.join(__dirname, 'players_override.json');
const LINEUPS_KEY = '__saved_lineups__'; // 特殊 Key 用於存儲陣容

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

const BASE_URL = 'http://bbapi.buzzerbeater.com';
const LOGIN = 'PPManager';
const CODE = 'bbpat_PPAPI1234';

let sessionCookie = '';
let cachedTeamData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;

function loadOverrides() {
    if (fs.existsSync(OVERRIDE_FILE)) return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
    fs.writeFileSync(OVERRIDE_FILE, '{}');
    return {};
}

function saveOverrides(data) {
    fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(data, null, 2));
}

// ================= 陣容管理 API =================
app.get('/api/lineups', (req, res) => {
    const overrides = loadOverrides();
    res.json(overrides[LINEUPS_KEY] || []);
});

app.post('/api/lineups', (req, res) => {
    const { action, data, id } = req.body;
    const overrides = loadOverrides();
    let lineups = overrides[LINEUPS_KEY] || [];
    
    if (action === 'save') {
        lineups.push({ id: Date.now().toString(), ...data });
    } else if (action === 'delete') {
        lineups = lineups.filter(l => l.id !== id);
    }
    
    overrides[LINEUPS_KEY] = lineups;
    saveOverrides(overrides);
    res.json({ success: true, lineups });
});

// ================= 球員數據 API =================
async function ensureLogin() {
    try {
        const response = await axios.get(`${BASE_URL}/login.aspx`, { params: { login: LOGIN, code: CODE } });
        const cookies = response.headers['set-cookie'];
        if (cookies) sessionCookie = cookies.join('; ');
    } catch (error) { console.error('❌ API 登入失敗:', error.message); }
}

async function fetchXML(endpoint, params = {}) {
    await ensureLogin();
    try {
        const response = await axios.get(`${BASE_URL}/${endpoint}`, { params, headers: { Cookie: sessionCookie } });
        const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true, trim: true });
        return (await parser.parseStringPromise(response.data)).bbapi;
    } catch (error) {
        console.error(`❌ 獲取 ${endpoint} 失敗:`, error.message);
        return null;
    }
}

app.get('/api/team-data', async (req, res) => {
    const now = Date.now();
    if (cachedTeamData && (now - lastFetchTime < CACHE_DURATION)) return res.json(cachedTeamData);

    const playerIds = ["56255447", "54893888", "54543188", "54102538", "55279069", "54859055", "54945877", "55597652", "54950319", "54543194", "55162789", "53526116", "56255448", "56255449", "55579726"];
    const players = [];
    await ensureLogin();

    for (const id of playerIds) {
        try {
            const data = await fetchXML('player.aspx', { playerid: id });
            if (data?.player) players.push(data.player);
        } catch (err) { console.error(`跳過球員 ${id}:`, err.message); }
    }

    let statsMap = {};
    try {
        const statsData = await fetchXML('teamstats.aspx', { mode: 'averages' });
        if (statsData?.teamStats?.player) {
            const statsPlayers = Array.isArray(statsData.teamStats.player) ? statsData.teamStats.player : [statsData.teamStats.player];
            statsPlayers.forEach(p => { statsMap[p.id] = p.stats; });
        }
    } catch (err) { console.error("獲取球隊統計失敗:", err.message); }

    const overrides = loadOverrides();

    cachedTeamData = players.map(p => {
        const s = p.skills || {};
        const st = statsMap[p.id] || {};
        const games = parseFloat(st.games) || 0;
        const mpg = parseFloat(st.mpg) || 0;
        
        const overrideData = overrides[p.id] || {};
        const overrideSkills = overrideData.skills || {};
        const overrideStats = overrideData.stats || {};

        const finalSkills = {
            gameShape: parseInt(s.gameShape) || 0, potential: parseInt(s.potential) || 0,
            jumpShot: parseInt(s.jumpShot) || 0, range: parseInt(s.range) || 0,
            outsideDef: parseInt(s.outsideDef) || 0, handling: parseInt(s.handling) || 0,
            driving: parseInt(s.driving) || 0, passing: parseInt(s.passing) || 0,
            insideShot: parseInt(s.insideShot) || 0, insideDef: parseInt(s.insideDef) || 0,
            rebound: parseInt(s.rebound) || 0, block: parseInt(s.block) || 0,
            stamina: parseInt(s.stamina) || 0, freeThrow: parseInt(s.freeThrow) || 0,
            experience: parseInt(s.experience) || 0
        };
        for (const key in overrideSkills) {
            if (overrideSkills[key] !== null && overrideSkills[key] !== undefined && !isNaN(overrideSkills[key])) {
                finalSkills[key] = overrideSkills[key];
            }
        }
        finalSkills.outsideTotal = finalSkills.jumpShot + finalSkills.range + finalSkills.outsideDef + finalSkills.handling + finalSkills.driving + finalSkills.passing;
        finalSkills.insideTotal = finalSkills.insideShot + finalSkills.insideDef + finalSkills.rebound + finalSkills.block;

        const defaultPosMins = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 };
        const posMins = overrideStats.positionMinutes || defaultPosMins;
        ['PG', 'SG', 'SF', 'PF', 'C'].forEach(pos => { if (posMins[pos] === undefined) posMins[pos] = 0; });
        
        const hasPosMins = Object.values(posMins).some(v => v > 0);
        const apiTotalMinutes = Math.round(mpg * games);
        const finalTotalMinutes = hasPosMins ? (posMins.PG + posMins.SG + posMins.SF + posMins.PF + posMins.C) : apiTotalMinutes;

        return {
            id: p.id, firstName: p.firstName, lastName: p.lastName,
            age: parseInt(p.age) || 0, height: parseInt(p.height) || 0,
            jersey: p.jersey, bestPosition: overrideStats.bestPosition || p.bestPosition, //優先使用手動覆蓋的最佳位置，若無則使用 API 原始數據
            skills: finalSkills,
            stats: { 
                games, mpg, totalMinutes: finalTotalMinutes, 
                positionMinutes: posMins, 
                bestPosition: overrideStats.bestPosition || null, // 優先讀取手動覆蓋的位置
                ppg: st.ppg || 0, rpg: st.rpg || 0, apg: st.apg || 0, rating: st.rating || 0 
            },
            isOverridden: Object.keys(overrideData).length > 0
        };
    });
    
    lastFetchTime = now;
    res.json(cachedTeamData);
});

app.post('/api/update-players-batch', (req, res) => {
    const { updates } = req.body;
    if (!Array.isArray(updates)) return res.status(400).json({ error: "數據格式錯誤" });

    const overrides = loadOverrides();

    updates.forEach(update => {
        const { id, skills, stats } = update;
        if (!id || id === LINEUPS_KEY) return; // 防呆：避免誤刪陣容數據

        const hasSkills = skills && Object.keys(skills).length > 0;
        const hasStats = stats && (Object.keys(stats).length > 0 || stats.positionMinutes);

        if (!hasSkills && !hasStats) {
            delete overrides[id];
        } else {
            overrides[id] = { skills: skills || {}, stats: stats || {} };
        }
    });

    saveOverrides(overrides);
    cachedTeamData = null;
    res.json({ success: true });
});

app.get('/api/stadium-data', async (req, res) => {
    try {
        const data = await fetchXML('arena.aspx', { teamid: 197615 });
        if (data?.arena) res.json(data.arena);
        else res.status(500).json({ error: "無法解析場館數據" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`✅ 伺服器已啟動於 http://localhost:${PORT}`));