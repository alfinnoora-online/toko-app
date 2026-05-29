import { useState, useEffect, useCallback, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// SUPABASE CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
const SB_URL = "https://olvccushxrdcegxltmxc.supabase.co";
const SB_KEY = "sb_publishable_D74fQBpyX1lc-G8-HBAvqw_ga8g0o9l";
const sbHeaders = {
  "Content-Type": "application/json",
  "apikey": SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
};

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function sbGet(table, filter="") {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { headers: sbHeaders });
    if(!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function sbUpsert(table, data) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify(data),
    });
    return r.ok;
  } catch { return false; }
}

async function sbDelete(table, filter) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
      method: "DELETE", headers: sbHeaders,
    });
    return r.ok;
  } catch { return false; }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function hashPassword(password) {
  const data = new TextEncoder().encode(password + "toku-salt-2024");
  const buf  = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

// ── Ops log cloud helpers ─────────────────────────────────────────────────────
async function cloudGetOps(username) {
  const rows = await sbGet("ops_log", `username=eq.${username}&order=ts.asc`);
  return rows || [];
}

async function cloudPushOps(ops) {
  if(!ops.length) return true;
  const rows = ops.map(op=>({
    id: op.id, username: op.username, device_id: op.deviceId,
    ts: op.ts, type: op.type, payload: op.payload,
  }));
  return await sbUpsert("ops_log", rows);
}
function localLoad(u)    { try{const r=localStorage.getItem(`toko-local-${u}`);return r?JSON.parse(r):null;}catch{return null;} }
function localSave(u,s)  { try{localStorage.setItem(`toko-local-${u}`,JSON.stringify(s));}catch{} }
function getSession()    { try{return JSON.parse(localStorage.getItem("toko-session")||"null");}catch{return null;} }
function setSession(u)   { try{localStorage.setItem("toko-session",u?JSON.stringify(u):"null");}catch{} }
const DEVICE_ID = (()=>{ let id=localStorage.getItem("toko-device-id"); if(!id){id="dev-"+Math.random().toString(36).slice(2,8);localStorage.setItem("toko-device-id",id);} return id; })();

// ═══════════════════════════════════════════════════════════════════════════════
// OP ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
const mkOp = (type,payload,username) => ({
  id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
  deviceId: DEVICE_ID, username, ts: Date.now(), type, payload,
});

function applyOps(state, ops) {
  const seen = new Set(state.appliedOpIds||[]);
  const newOps = ops.filter(op=>!seen.has(op.id));
  if(!newOps.length) return state;
  let produk     = state.produk.map(p=>({...p}));
  let transaksi  = [...state.transaksi];
  let pelanggan  = [...(state.pelanggan||[])];

  for(const op of newOps.sort((a,b)=>a.ts-b.ts)) {
    if(op.type==="TRX_ADD") {
      if(!transaksi.find(t=>t.id===op.payload.id)) {
        transaksi.push(op.payload);
        op.payload.items.forEach(item=>{
          const p=produk.find(x=>x.id===item.id);
          if(p) p.stok=Math.max(0,p.stok-item.qty);
        });
        // Tambah poin ke pelanggan jika ada
        if(op.payload.pelangganId) {
          const pl=pelanggan.find(x=>x.id===op.payload.pelangganId);
          if(pl) {
            pl.poin=(pl.poin||0)+Math.floor(op.payload.total/1000);
            pl.totalBelanja=(pl.totalBelanja||0)+op.payload.total;
            pl.jumlahTransaksi=(pl.jumlahTransaksi||0)+1;
            pl.transaksiTerakhir=op.payload.tanggal;
          }
        }
      }
    } else if(op.type==="PRODUK_UPSERT") {
      const idx=produk.findIndex(p=>p.id===op.payload.id);
      if(idx>=0){ if((op.payload.updatedAt||op.ts)>=(produk[idx].updatedAt||0)) produk[idx]={...produk[idx],...op.payload,updatedAt:op.payload.updatedAt||op.ts}; }
      else produk.push({...op.payload,updatedAt:op.payload.updatedAt||op.ts});
    } else if(op.type==="PRODUK_DEL") {
      produk=produk.filter(p=>p.id!==op.payload.id);
    } else if(op.type==="STOK_ADJ") {
      const p=produk.find(x=>x.id===op.payload.id);
      if(p) p.stok=Math.max(0,p.stok+op.payload.delta);
    } else if(op.type==="PELANGGAN_UPSERT") {
      const idx=pelanggan.findIndex(x=>x.id===op.payload.id);
      if(idx>=0){ if((op.payload.updatedAt||op.ts)>=(pelanggan[idx].updatedAt||0)) pelanggan[idx]={...pelanggan[idx],...op.payload}; }
      else pelanggan.push({...op.payload,poin:op.payload.poin||0,totalBelanja:0,jumlahTransaksi:0});
    } else if(op.type==="PELANGGAN_DEL") {
      pelanggan=pelanggan.filter(x=>x.id!==op.payload.id);
    } else if(op.type==="TUKAR_POIN") {
      const pl=pelanggan.find(x=>x.id===op.payload.id);
      if(pl) pl.poin=Math.max(0,(pl.poin||0)-op.payload.poin);
    }
    seen.add(op.id);
  }
  transaksi.sort((a,b)=>new Date(b.tanggal)-new Date(a.tanggal));
  return {...state,produk,transaksi,pelanggan,appliedOpIds:[...seen]};
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════
const fmt     = n=>new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",minimumFractionDigits:0}).format(n);
const fmtDate = iso=>new Date(iso).toLocaleDateString("id-ID",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
const fmtShort= iso=>new Date(iso).toLocaleDateString("id-ID",{day:"2-digit",month:"short",year:"numeric"});
const uid     = ()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);

const tierInfo = poin => {
  if(poin>=5000) return {tier:"Platinum",color:"#b9f2ff",bg:"#1a3a4a",next:null};
  if(poin>=2000) return {tier:"Gold",color:"#f9c74f",bg:"#3a2e0a",next:5000};
  if(poin>=500)  return {tier:"Silver",color:"#c0c0c0",bg:"#2a2a2a",next:2000};
  return {tier:"Bronze",color:"#cd7f32",bg:"#2e1e0a",next:500};
};

// ═══════════════════════════════════════════════════════════════════════════════
// ICONS
// ═══════════════════════════════════════════════════════════════════════════════
const Icon = ({d,size=20,color="currentColor"})=>(
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={d}/></svg>
);
const icons = {
  store:   "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  cart:    "M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4zM3 6h18M16 10a4 4 0 01-8 0",
  box:     "M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z",
  chart:   "M18 20V10M12 20V4M6 20v-6",
  plus:    "M12 5v14M5 12h14",
  trash:   "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  edit:    "M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z",
  check:   "M20 6L9 17l-5-5",
  wifi:    "M5 12.55a11 11 0 0114.08 0M1.42 9a16 16 0 0121.16 0M8.53 16.11a6 16 0 016.95 0M12 20h.01",
  wifiOff: "M1 1l22 22M16.72 11.06A10.94 10.94 0 0119 12.55M5 12.55a10.94 10.94 0 015.17-2.39M10.71 5.05A16 16 0 0122.56 9M1.42 9a15.91 15.91 0 014.7-2.88M8.53 16.11a6 6 0 016.95 0M12 20h.01",
  receipt: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  pkg:     "M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12",
  warning: "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01",
  search:  "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0",
  user:    "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z",
  users:   "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  logout:  "M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9",
  lock:    "M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 0110 0v4",
  eye:     "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 100 6 3 3 0 000-6z",
  eyeOff:  "M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22",
  shop:    "M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z",
  star:    "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  phone:   "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z",
  map:     "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0zM12 10a1 1 0 100-2 1 1 0 000 2z",
  gift:    "M20 12v10H4V12M22 7H2v5h20V7zM12 22V7M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z",
  x:       "M18 6L6 18M6 6l12 12",
};

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function AuthScreen({onLogin}) {
  const [mode,setMode]       = useState("login");
  const [form,setForm]       = useState({username:"",password:"",namaToko:""});
  const [showPass,setShowPass]= useState(false);
  const [loading,setLoading] = useState(false);
  const [error,setError]     = useState("");
  const set=(k,v)=>{setForm(f=>({...f,[k]:v}));setError("");};

  const handleLogin = async()=>{
    if(!form.username||!form.password) return setError("Username dan password wajib diisi");
    setLoading(true);
    const key=form.username.toLowerCase();
    const rows=await sbGet("accounts",`username=eq.${key}`);
    if(!rows||rows.length===0){setLoading(false);return setError("Akun tidak ditemukan. Pastikan username benar.");}
    const acc=rows[0];
    const hash=await hashPassword(form.password);
    if(hash!==acc.password_hash){setLoading(false);return setError("Password salah.");}
    const u={username:key,namaToko:acc.nama_toko};
    setSession(u); onLogin(u); setLoading(false);
  };

  const handleRegister = async()=>{
    if(!form.username||!form.password||!form.namaToko) return setError("Semua kolom wajib diisi");
    if(form.username.length<3) return setError("Username minimal 3 karakter");
    if(form.password.length<6) return setError("Password minimal 6 karakter");
    if(!/^[a-zA-Z0-9_]+$/.test(form.username)) return setError("Username hanya huruf, angka, dan _");
    setLoading(true);
    const key=form.username.toLowerCase();
    const existing=await sbGet("accounts",`username=eq.${key}`);
    if(existing&&existing.length>0){setLoading(false);return setError("Username sudah dipakai, coba username lain.");}
    const hash=await hashPassword(form.password);
    const ok=await sbUpsert("accounts",[{username:key,password_hash:hash,nama_toko:form.namaToko}]);
    if(!ok){setLoading(false);return setError("Gagal menyimpan akun. Periksa koneksi internet.");}
    const u={username:key,namaToko:form.namaToko};
    setSession(u); onLogin(u); setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh",background:"#0f1117",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"'Outfit',sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}input{outline:none;font-family:inherit}button{cursor:pointer;font-family:inherit}@keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}.fade{animation:fadeIn .3s ease}`}</style>
      <div className="fade" style={{width:"100%",maxWidth:380}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{width:64,height:64,background:"linear-gradient(135deg,#2d6a4f,#52b788)",borderRadius:18,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px"}}>
            <Icon d={icons.shop} size={30} color="#fff"/>
          </div>
          <div style={{fontWeight:800,fontSize:26,letterSpacing:"-0.5px",color:"#e8eaf0"}}>TokoKu</div>
          <div style={{fontSize:13,color:"#52b788",marginTop:4}}>Manajemen Penjualan Multi-Toko</div>
        </div>
        <div style={{display:"flex",background:"#141720",borderRadius:12,padding:4,marginBottom:24,border:"1px solid #1e2535"}}>
          {["login","register"].map(m=>(
            <button key={m} onClick={()=>{setMode(m);setError("");}} style={{flex:1,padding:"10px",borderRadius:9,border:"none",background:mode===m?"linear-gradient(135deg,#2d6a4f,#52b788)":"transparent",color:mode===m?"#fff":"#4a5568",fontWeight:600,fontSize:13,transition:"all .2s"}}>
              {m==="login"?"Masuk":"Daftar"}
            </button>
          ))}
        </div>
        <div style={{background:"#141720",border:"1px solid #1e2535",borderRadius:16,padding:20,display:"flex",flexDirection:"column",gap:14}}>
          {mode==="register"&&<Field label="Nama Toko" placeholder="mis: Warung Pak Budi" value={form.namaToko} onChange={v=>set("namaToko",v)} icon={icons.store}/>}
          <Field label="Username" placeholder="mis: pakbudi" value={form.username} onChange={v=>set("username",v.toLowerCase())} icon={icons.user}/>
          <Field label="Password" placeholder="Minimal 6 karakter" value={form.password} onChange={v=>set("password",v)} icon={icons.lock} type={showPass?"text":"password"}
            suffix={<button onClick={()=>setShowPass(s=>!s)} style={{background:"none",border:"none",color:"#4a5568",padding:0,display:"flex"}}><Icon d={showPass?icons.eyeOff:icons.eye} size={16} color="#4a5568"/></button>}/>
          {error&&<div style={{background:"#2e1a1a",border:"1px solid #6a2d2d",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#e57373"}}>{error}</div>}
          <button onClick={mode==="login"?handleLogin:handleRegister} disabled={loading}
            style={{padding:"13px",background:loading?"#1e2535":"linear-gradient(135deg,#2d6a4f,#52b788)",border:"none",borderRadius:10,color:loading?"#4a5568":"#fff",fontWeight:700,fontSize:14,marginTop:4}}>
            {loading?"Memproses…":mode==="login"?"Masuk":"Buat Akun"}
          </button>
        </div>
        <div style={{textAlign:"center",fontSize:12,color:"#4a5568",marginTop:20}}>Data setiap toko tersimpan terpisah & aman</div>
      </div>
    </div>
  );
}

function Field({label,placeholder,value,onChange,icon,type="text",suffix}) {
  return (
    <div>
      <label style={{fontSize:11,color:"#8a9ba8",display:"block",marginBottom:5,fontWeight:500}}>{label}</label>
      <div style={{display:"flex",alignItems:"center",background:"#0f1117",border:"1px solid #1e2535",borderRadius:9,padding:"10px 12px",gap:9}}>
        <Icon d={icon} size={15} color="#4a5568"/>
        <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
          style={{flex:1,background:"none",border:"none",color:"#e8eaf0",fontSize:13}}/>
        {suffix}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════════════════
export default function TokoApp() {
  const [user,setUser]         = useState(null);
  const [authReady,setAuthReady]= useState(false);
  useEffect(()=>{setUser(getSession());setAuthReady(true);},[]);
  if(!authReady) return <Loader/>;
  if(!user) return <AuthScreen onLogin={u=>{setUser(u);}}/>;
  return <MainApp user={user} onLogout={()=>{setSession(null);setUser(null);}}/>;
}

function Loader() {
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#0f1117"}}>
      <div style={{width:36,height:36,border:"3px solid #2d6a4f",borderTop:"3px solid #52b788",borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
function MainApp({user,onLogout}) {
  const [state,setState]           = useState(null);
  const [tab,setTab]               = useState("kasir");
  const [online,setOnline]         = useState(navigator.onLine);
  const [syncStatus,setSyncStatus] = useState("idle");
  const [loading,setLoading]       = useState(true);
  const [pendingOps,setPendingOps] = useState([]);
  const [showLogout,setShowLogout] = useState(false);
  const pendingRef = useRef([]);

  useEffect(()=>{
    async function init() {
      const local = localLoad(user.username);
      let base = {
        produk:[], transaksi:[], pelanggan:[], appliedOpIds:[],
        ...(local||{}), pelanggan:local?.pelanggan||[],
      };
      if(navigator.onLine){
        const cloudOps=await cloudGetOps(user.username);
        base=applyOps(base,cloudOps);
        localSave(user.username,base);
      }
      setState(base);
      const saved=JSON.parse(localStorage.getItem(`toko-pending-${user.username}`)||"[]");
      setPendingOps(saved); pendingRef.current=saved;
      setLoading(false);
    }
    init();
    const onOnline=async()=>{
      setOnline(true);
      const pending=pendingRef.current;
      if(!pending.length) {
        // Pull saja update dari perangkat lain
        const cloudOps=await cloudGetOps(user.username);
        const ls=localLoad(user.username);
        const lsBase={produk:[],transaksi:[],pelanggan:[],appliedOpIds:[],...(ls||{}),pelanggan:ls?.pelanggan||[]};
        const ns=applyOps(lsBase,cloudOps);
        localSave(user.username,ns); setState(ns);
        return;
      }
      setSyncStatus("syncing");
      const ok=await cloudPushOps(pending);
      if(ok){
        const cloudOps=await cloudGetOps(user.username);
        const ls=localLoad(user.username);
        const lsBase={produk:[],transaksi:[],pelanggan:[],appliedOpIds:[],...(ls||{}),pelanggan:ls?.pelanggan||[]};
        const ns=applyOps(lsBase,cloudOps);
        localSave(user.username,ns); setState(ns);
        setPendingOps([]); pendingRef.current=[];
        localStorage.setItem(`toko-pending-${user.username}`,"[]");
        setSyncStatus("synced"); setTimeout(()=>setSyncStatus("idle"),2500);
      } else setSyncStatus("idle");
    };
    const onOffline=()=>setOnline(false);
    window.addEventListener("online",onOnline);
    window.addEventListener("offline",onOffline);
    return()=>{window.removeEventListener("online",onOnline);window.removeEventListener("offline",onOffline);};
  },[user.username]);

  useEffect(()=>{
    const iv=setInterval(async()=>{
      if(!navigator.onLine||pendingRef.current.length>0) return;
      const cloudOps=await cloudGetOps(user.username);
      const ls=localLoad(user.username);
      if(!ls) return;
      const lsBase={produk:[],transaksi:[],pelanggan:[],appliedOpIds:[],...ls,pelanggan:ls.pelanggan||[]};
      const ns=applyOps(lsBase,cloudOps);
      if(ns.appliedOpIds.length!==lsBase.appliedOpIds.length){
        localSave(user.username,ns); setState(ns);
        setSyncStatus("synced"); setTimeout(()=>setSyncStatus("idle"),2000);
      }
    },30000);
    return()=>clearInterval(iv);
  },[user.username]);

  const dispatch=useCallback(async(type,payload)=>{
    const op=mkOp(type,payload,user.username);
    setState(prev=>{const next=applyOps(prev,[op]);localSave(user.username,next);return next;});
    if(navigator.onLine){
      setSyncStatus("syncing");
      await cloudPushOps([op]);
      const cloudOps=await cloudGetOps(user.username);
      const ls=localLoad(user.username);
      const lsBase={produk:[],transaksi:[],pelanggan:[],appliedOpIds:[],...(ls||{}),pelanggan:ls?.pelanggan||[]};
      const ns=applyOps(lsBase,cloudOps);
      localSave(user.username,ns); setState(ns);
      setSyncStatus("synced"); setTimeout(()=>setSyncStatus("idle"),2000);
    } else {
      const np=[...pendingRef.current,op];
      pendingRef.current=np; setPendingOps(np);
      localStorage.setItem(`toko-pending-${user.username}`,JSON.stringify(np));
    }
  },[user.username]);

  if(loading) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",background:"#0f1117",fontFamily:"'Outfit',sans-serif",gap:14}}>
      <div style={{width:42,height:42,border:"3px solid #2d6a4f",borderTop:"3px solid #52b788",borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
      <p style={{color:"#8a9ba8",fontSize:13}}>Memuat {user.namaToko}…</p>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  const tabs=[
    {id:"kasir",  label:"Kasir",    icon:icons.cart},
    {id:"produk", label:"Produk",   icon:icons.box},
    {id:"stok",   label:"Stok",     icon:icons.pkg},
    {id:"crm",    label:"Pelanggan",icon:icons.users},
    {id:"laporan",label:"Laporan",  icon:icons.chart},
  ];

  return (
    <div style={{fontFamily:"'Outfit',sans-serif",background:"#0f1117",minHeight:"100vh",color:"#e8eaf0",display:"flex",flexDirection:"column",maxWidth:480,margin:"0 auto"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#1a1d27}::-webkit-scrollbar-thumb{background:#2d6a4f;border-radius:4px}
        input,select,textarea{outline:none;font-family:inherit}button{cursor:pointer;font-family:inherit}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .fade{animation:fadeIn .2s ease}
      `}</style>

      {/* Header */}
      <div style={{background:"#141720",borderBottom:"1px solid #1e2535",padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:36,height:36,background:"linear-gradient(135deg,#2d6a4f,#52b788)",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <Icon d={icons.store} size={18} color="#fff"/>
          </div>
          <div>
            <div style={{fontWeight:700,fontSize:14,letterSpacing:"-0.3px",lineHeight:1.2}}>{user.namaToko}</div>
            <div style={{fontSize:10,color:"#52b788"}}>@{user.username}</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          <div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:online?"#52b788":"#e57373",background:online?"#1a2e23":"#2e1a1a",padding:"4px 9px",borderRadius:20,border:`1px solid ${online?"#2d6a4f":"#6a2d2d"}`}}>
            <Icon d={online?icons.wifi:icons.wifiOff} size={12} color="currentColor"/>
            {online?"Online":"Offline"}
          </div>
          {syncStatus==="syncing"&&<div style={{width:14,height:14,border:"2px solid #f9c74f44",borderTop:"2px solid #f9c74f",borderRadius:"50%",animation:"spin .8s linear infinite"}}/>}
          {syncStatus==="synced"&&<Icon d={icons.check} size={14} color="#52b788"/>}
          {!online&&pendingOps.length>0&&<div style={{fontSize:10,color:"#f9c74f",background:"#2e2a1a",padding:"3px 7px",borderRadius:10,border:"1px solid #6a5a2d"}}>{pendingOps.length} pending</div>}
          <button onClick={()=>setShowLogout(true)} style={{background:"#1e2535",border:"none",borderRadius:8,padding:"6px 8px",color:"#8a9ba8",display:"flex",alignItems:"center"}}>
            <Icon d={icons.logout} size={15} color="#8a9ba8"/>
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{flex:1,overflowY:"auto",paddingBottom:80}}>
        {tab==="kasir"   && <Kasir   state={state} dispatch={dispatch}/>}
        {tab==="produk"  && <Produk  state={state} dispatch={dispatch}/>}
        {tab==="stok"    && <Stok    state={state} dispatch={dispatch}/>}
        {tab==="crm"     && <CRM     state={state} dispatch={dispatch}/>}
        {tab==="laporan" && <Laporan state={state}/>}
      </div>

      {/* Bottom Nav */}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:480,background:"#141720",borderTop:"1px solid #1e2535",display:"flex",zIndex:100}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,padding:"8px 0 10px",background:"none",border:"none",display:"flex",flexDirection:"column",alignItems:"center",gap:3,color:tab===t.id?"#52b788":"#4a5568",transition:"color .2s"}}>
            <Icon d={t.icon} size={18} color="currentColor"/>
            <span style={{fontSize:9,fontWeight:tab===t.id?600:400}}>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Logout modal */}
      {showLogout&&(
        <div style={{position:"fixed",inset:0,background:"#000a",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:200,maxWidth:480,margin:"0 auto"}}>
          <div className="fade" style={{background:"#141720",border:"1px solid #1e2535",borderRadius:"16px 16px 0 0",padding:24,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:6}}>Keluar dari {user.namaToko}?</div>
            <div style={{fontSize:13,color:"#8a9ba8",marginBottom:20}}>Data tetap tersimpan. Kamu bisa masuk lagi kapan saja.</div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setShowLogout(false)} style={{flex:1,padding:"12px",background:"#1e2535",border:"none",borderRadius:10,color:"#8a9ba8",fontWeight:600,fontSize:13}}>Batal</button>
              <button onClick={onLogout} style={{flex:1,padding:"12px",background:"#2e1a1a",border:"1px solid #6a2d2d",borderRadius:10,color:"#e57373",fontWeight:700,fontSize:13}}>Keluar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// KASIR — dengan pilih pelanggan
// ═══════════════════════════════════════════════════════════════════════════════
function Kasir({state,dispatch}) {
  const [keranjang,setKeranjang]   = useState([]);
  const [search,setSearch]         = useState("");
  const [bayar,setBayar]           = useState("");
  const [receipt,setReceipt]       = useState(null);
  const [katFilter,setKatFilter]   = useState("Semua");
  const [pelangganId,setPelangganId]= useState("");
  const [searchPl,setSearchPl]     = useState("");
  const [showPl,setShowPl]         = useState(false);

  const kategori=["Semua",...new Set(state.produk.map(p=>p.kategori))];
  const filtered=state.produk.filter(p=>(katFilter==="Semua"||p.kategori===katFilter)&&p.nama.toLowerCase().includes(search.toLowerCase())&&p.stok>0);
  const pelangganDipilih=state.pelanggan.find(x=>x.id===pelangganId);
  const plFiltered=state.pelanggan.filter(p=>p.nama.toLowerCase().includes(searchPl.toLowerCase())||p.telepon?.includes(searchPl));

  const addItem=p=>setKeranjang(k=>{
    const ex=k.find(i=>i.id===p.id);
    if(ex){if(ex.qty>=p.stok)return k;return k.map(i=>i.id===p.id?{...i,qty:i.qty+1}:i);}
    return [...k,{...p,qty:1}];
  });
  const updQty=(id,d)=>setKeranjang(k=>k.map(i=>i.id===id?{...i,qty:Math.max(0,i.qty+d)}:i).filter(i=>i.qty>0));
  const total=keranjang.reduce((s,i)=>s+i.harga*i.qty,0);
  const bayarNum=parseInt(bayar.replace(/\D/g,"")||0);
  const kembalian=bayarNum-total;
  const poinDapat=Math.floor(total/1000);

  const bayarHandler=async()=>{
    if(!keranjang.length||kembalian<0) return;
    const trx={id:uid(),tanggal:new Date().toISOString(),deviceId:DEVICE_ID,
      items:keranjang.map(i=>({id:i.id,nama:i.nama,harga:i.harga,qty:i.qty})),
      total,bayar:bayarNum,kembalian,pelangganId:pelangganId||null,
      pelangganNama:pelangganDipilih?.nama||null,poinDapat};
    await dispatch("TRX_ADD",trx);
    setReceipt(trx); setKeranjang([]); setBayar(""); setPelangganId("");
  };

  if(receipt) return (
    <div className="fade" style={{padding:16}}>
      <div style={{background:"#141720",border:"1px solid #2d6a4f",borderRadius:16,padding:20,textAlign:"center"}}>
        <div style={{width:52,height:52,background:"#1a2e23",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px"}}>
          <Icon d={icons.check} size={26} color="#52b788"/>
        </div>
        <div style={{fontWeight:700,fontSize:18,marginBottom:4}}>Transaksi Berhasil!</div>
        <div style={{color:"#52b788",fontSize:22,fontWeight:700,marginBottom:8}}>{fmt(receipt.total)}</div>
        {receipt.pelangganNama&&(
          <div style={{background:"#1a2e23",borderRadius:8,padding:"6px 12px",fontSize:12,color:"#52b788",marginBottom:12,display:"inline-flex",alignItems:"center",gap:6}}>
            <Icon d={icons.star} size={12} color="#f9c74f"/> +{receipt.poinDapat} poin untuk {receipt.pelangganNama}
          </div>
        )}
        <div style={{background:"#0f1117",borderRadius:10,padding:12,textAlign:"left",marginBottom:16}}>
          {receipt.items.map(i=>(
            <div key={i.id} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:13,color:"#8a9ba8"}}>
              <span>{i.nama} x{i.qty}</span><span style={{color:"#e8eaf0"}}>{fmt(i.harga*i.qty)}</span>
            </div>
          ))}
          <div style={{borderTop:"1px solid #1e2535",marginTop:8,paddingTop:8,display:"flex",justifyContent:"space-between",fontSize:13}}>
            <span>Bayar</span><span>{fmt(receipt.bayar)}</span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontWeight:700,color:"#52b788",marginTop:4}}>
            <span>Kembalian</span><span>{fmt(receipt.kembalian)}</span>
          </div>
        </div>
        <button onClick={()=>setReceipt(null)} style={{width:"100%",padding:"12px",background:"linear-gradient(135deg,#2d6a4f,#52b788)",color:"#fff",border:"none",borderRadius:10,fontWeight:600,fontSize:14}}>Transaksi Baru</button>
      </div>
    </div>
  );

  return (
    <div className="fade">
      <div style={{padding:"12px 16px 8px"}}>
        {/* Pilih pelanggan */}
        <div style={{background:"#141720",border:"1px solid #1e2535",borderRadius:10,padding:"8px 12px",marginBottom:10}}>
          {pelangganDipilih ? (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:28,height:28,background:"linear-gradient(135deg,#2d6a4f,#52b788)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:"#fff"}}>
                  {pelangganDipilih.nama[0].toUpperCase()}
                </div>
                <div>
                  <div style={{fontSize:13,fontWeight:600}}>{pelangganDipilih.nama}</div>
                  <div style={{fontSize:10,color:"#f9c74f"}}>⭐ {pelangganDipilih.poin||0} poin · +{poinDapat} poin transaksi ini</div>
                </div>
              </div>
              <button onClick={()=>{setPelangganId("");setShowPl(false);}} style={{background:"none",border:"none",color:"#4a5568",padding:4}}>
                <Icon d={icons.x} size={14} color="#4a5568"/>
              </button>
            </div>
          ) : (
            <button onClick={()=>setShowPl(s=>!s)} style={{width:"100%",background:"none",border:"none",display:"flex",alignItems:"center",gap:8,color:"#4a5568",fontSize:13}}>
              <Icon d={icons.user} size={15} color="#4a5568"/>
              <span>Pilih pelanggan (opsional)</span>
            </button>
          )}
        </div>

        {/* Dropdown pelanggan */}
        {showPl&&!pelangganDipilih&&(
          <div style={{background:"#141720",border:"1px solid #2d6a4f",borderRadius:10,marginBottom:10,overflow:"hidden"}}>
            <div style={{padding:"8px 12px",borderBottom:"1px solid #1e2535",display:"flex",alignItems:"center",gap:8}}>
              <Icon d={icons.search} size={13} color="#4a5568"/>
              <input value={searchPl} onChange={e=>setSearchPl(e.target.value)} placeholder="Cari nama / telepon…"
                style={{flex:1,background:"none",border:"none",color:"#e8eaf0",fontSize:13}}/>
            </div>
            {plFiltered.length===0 ? (
              <div style={{padding:"12px 14px",fontSize:12,color:"#4a5568"}}>Pelanggan tidak ditemukan</div>
            ) : plFiltered.slice(0,5).map(pl=>(
              <button key={pl.id} onClick={()=>{setPelangganId(pl.id);setShowPl(false);setSearchPl("");}}
                style={{width:"100%",padding:"10px 14px",background:"none",border:"none",borderBottom:"1px solid #0f1117",display:"flex",alignItems:"center",gap:10,textAlign:"left"}}>
                <div style={{width:28,height:28,background:"#1a2e23",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:"#52b788",flexShrink:0}}>
                  {pl.nama[0].toUpperCase()}
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:600,color:"#e8eaf0"}}>{pl.nama}</div>
                  <div style={{fontSize:10,color:"#4a5568"}}>{pl.telepon||"—"}</div>
                </div>
                <div style={{fontSize:11,color:"#f9c74f"}}>⭐ {pl.poin||0}</div>
              </button>
            ))}
          </div>
        )}

        <div style={{display:"flex",alignItems:"center",background:"#141720",border:"1px solid #1e2535",borderRadius:10,padding:"8px 12px",gap:8,marginBottom:10}}>
          <Icon d={icons.search} size={15} color="#4a5568"/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Cari produk…" style={{flex:1,background:"none",border:"none",color:"#e8eaf0",fontSize:13}}/>
        </div>
        <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4}}>
          {kategori.map(k=>(
            <button key={k} onClick={()=>setKatFilter(k)} style={{padding:"5px 12px",borderRadius:20,border:"1px solid",borderColor:katFilter===k?"#52b788":"#1e2535",background:katFilter===k?"#1a2e23":"transparent",color:katFilter===k?"#52b788":"#4a5568",fontSize:12,fontWeight:500,whiteSpace:"nowrap"}}>{k}</button>
          ))}
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,padding:"0 16px 8px"}}>
        {filtered.map(p=>(
          <button key={p.id} onClick={()=>addItem(p)} onTouchStart={e=>e.currentTarget.style.borderColor="#2d6a4f"} onTouchEnd={e=>e.currentTarget.style.borderColor="#1e2535"}
            style={{background:"#141720",border:"1px solid #1e2535",borderRadius:12,padding:12,textAlign:"left"}}>
            <div style={{fontSize:11,color:"#52b788",marginBottom:4,fontWeight:500}}>{p.kategori}</div>
            <div style={{fontWeight:600,fontSize:13,marginBottom:4,lineHeight:1.3}}>{p.nama}</div>
            <div style={{color:"#52b788",fontWeight:700,fontSize:14}}>{fmt(p.harga)}</div>
            <div style={{fontSize:10,color:p.stok<5?"#e57373":"#4a5568",marginTop:4}}>Stok: {p.stok} {p.satuan}</div>
          </button>
        ))}
        {filtered.length===0&&<div style={{gridColumn:"1/-1",textAlign:"center",color:"#4a5568",padding:32,fontSize:13}}>{state.produk.length===0?"Belum ada produk. Tambahkan di menu Produk dulu!":"Produk tidak ditemukan"}</div>}
      </div>

      {keranjang.length>0&&(
        <div style={{margin:"0 16px",background:"#141720",border:"1px solid #1e2535",borderRadius:14,overflow:"hidden"}}>
          <div style={{padding:"10px 14px",borderBottom:"1px solid #1e2535",fontWeight:600,fontSize:13,color:"#52b788",display:"flex",alignItems:"center",gap:6}}>
            <Icon d={icons.cart} size={14} color="#52b788"/> Keranjang ({keranjang.reduce((s,i)=>s+i.qty,0)} item)
          </div>
          {keranjang.map(item=>(
            <div key={item.id} style={{display:"flex",alignItems:"center",padding:"8px 14px",borderBottom:"1px solid #0f1117",gap:8}}>
              <div style={{flex:1,fontSize:13}}>{item.nama}</div>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <button onClick={()=>updQty(item.id,-1)} style={{width:26,height:26,borderRadius:8,border:"1px solid #1e2535",background:"#0f1117",color:"#e8eaf0",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
                <span style={{width:22,textAlign:"center",fontSize:13,fontWeight:600}}>{item.qty}</span>
                <button onClick={()=>updQty(item.id,1)} style={{width:26,height:26,borderRadius:8,border:"1px solid #2d6a4f",background:"#1a2e23",color:"#52b788",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
              </div>
              <div style={{fontSize:12,color:"#52b788",width:72,textAlign:"right",fontWeight:600}}>{fmt(item.harga*item.qty)}</div>
            </div>
          ))}
          <div style={{padding:"10px 14px"}}>
            <div style={{display:"flex",justifyContent:"space-between",fontWeight:700,fontSize:15,marginBottom:6}}>
              <span>Total</span><span style={{color:"#52b788"}}>{fmt(total)}</span>
            </div>
            {pelangganDipilih&&<div style={{fontSize:11,color:"#f9c74f",marginBottom:8}}>⭐ Pelanggan akan mendapat +{poinDapat} poin</div>}
            <input value={bayar} onChange={e=>{const r=e.target.value.replace(/\D/g,"");setBayar(r?parseInt(r).toLocaleString("id-ID"):"");}}
              placeholder="Jumlah bayar (Rp)" inputMode="numeric"
              style={{width:"100%",padding:"10px 12px",background:"#0f1117",border:"1px solid #1e2535",borderRadius:8,color:"#e8eaf0",fontSize:13,marginBottom:8}}/>
            {bayar&&<div style={{fontSize:12,color:kembalian>=0?"#52b788":"#e57373",marginBottom:8,textAlign:"right"}}>{kembalian>=0?`Kembalian: ${fmt(kembalian)}`:`Kurang: ${fmt(-kembalian)}`}</div>}
            <button onClick={bayarHandler} disabled={!bayar||kembalian<0} style={{width:"100%",padding:"12px",background:!bayar||kembalian<0?"#1e2535":"linear-gradient(135deg,#2d6a4f,#52b788)",color:!bayar||kembalian<0?"#4a5568":"#fff",border:"none",borderRadius:10,fontWeight:700,fontSize:14}}>
              Bayar Sekarang
            </button>
          </div>
        </div>
      )}
      <div style={{height:16}}/>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRM
// ═══════════════════════════════════════════════════════════════════════════════
function CRM({state,dispatch}) {
  const [view,setView]   = useState("list");  // list | form | detail
  const [form,setForm]   = useState(null);
  const [selected,setSelected] = useState(null);
  const [search,setSearch]     = useState("");
  const [tukarPoin,setTukarPoin]= useState("");

  const filtered=state.pelanggan.filter(p=>
    p.nama.toLowerCase().includes(search.toLowerCase())||
    p.telepon?.includes(search)||p.alamat?.toLowerCase().includes(search.toLowerCase())
  ).sort((a,b)=>(b.totalBelanja||0)-(a.totalBelanja||0));

  const savePelanggan=async()=>{
    if(!form.nama) return;
    await dispatch("PELANGGAN_UPSERT",{...form,id:form.id||uid(),updatedAt:Date.now()});
    setView("list"); setForm(null);
  };

  const hapusPelanggan=async(id)=>{
    await dispatch("PELANGGAN_DEL",{id});
    setView("list"); setSelected(null);
  };

  const handleTukarPoin=async()=>{
    const p=parseInt(tukarPoin||0);
    if(!p||p>selected.poin) return;
    await dispatch("TUKAR_POIN",{id:selected.id,poin:p});
    setSelected(prev=>({...prev,poin:(prev.poin||0)-p}));
    setTukarPoin("");
  };

  const riwayat=state.transaksi.filter(t=>t.pelangganId===selected?.id);

  // ── Detail pelanggan ──
  if(view==="detail"&&selected) {
    const pl=state.pelanggan.find(x=>x.id===selected.id)||selected;
    const {tier,color,bg,next}=tierInfo(pl.poin||0);
    return (
      <div className="fade" style={{padding:16}}>
        <button onClick={()=>setView("list")} style={{background:"none",border:"none",color:"#52b788",fontSize:13,fontWeight:600,marginBottom:14,display:"flex",alignItems:"center",gap:6,padding:0}}>
          ← Kembali
        </button>

        {/* Kartu pelanggan */}
        <div style={{background:"linear-gradient(135deg,#1a2e23,#141720)",border:"1px solid #2d6a4f",borderRadius:16,padding:20,marginBottom:14}}>
          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
            <div style={{width:52,height:52,background:"linear-gradient(135deg,#2d6a4f,#52b788)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,fontWeight:700,color:"#fff",flexShrink:0}}>
              {pl.nama[0].toUpperCase()}
            </div>
            <div>
              <div style={{fontWeight:700,fontSize:16}}>{pl.nama}</div>
              {pl.telepon&&<div style={{fontSize:12,color:"#8a9ba8",marginTop:2}}>{pl.telepon}</div>}
              {pl.alamat&&<div style={{fontSize:12,color:"#8a9ba8"}}>{pl.alamat}</div>}
            </div>
          </div>

          {/* Tier badge */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:bg,borderRadius:10,padding:"10px 14px",marginBottom:12}}>
            <div>
              <div style={{fontSize:10,color:"#8a9ba8",marginBottom:2}}>STATUS MEMBER</div>
              <div style={{fontSize:16,fontWeight:700,color}}>{tier}</div>
              {next&&<div style={{fontSize:10,color:"#4a5568",marginTop:2}}>{next-(pl.poin||0)} poin lagi ke tier berikutnya</div>}
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:10,color:"#8a9ba8",marginBottom:2}}>TOTAL POIN</div>
              <div style={{fontSize:24,fontWeight:700,color:"#f9c74f"}}>{pl.poin||0}</div>
            </div>
          </div>

          {/* Statistik */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[
              {label:"Total Belanja",val:fmt(pl.totalBelanja||0),color:"#52b788"},
              {label:"Jumlah Transaksi",val:pl.jumlahTransaksi||0,color:"#64b5f6"},
            ].map(s=>(
              <div key={s.label} style={{background:"#0f1117",borderRadius:8,padding:"8px 12px"}}>
                <div style={{fontSize:10,color:"#4a5568",marginBottom:4}}>{s.label}</div>
                <div style={{fontSize:15,fontWeight:700,color:s.color}}>{s.val}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Tukar poin */}
        <div style={{background:"#141720",border:"1px solid #1e2535",borderRadius:12,padding:14,marginBottom:14}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:10,display:"flex",alignItems:"center",gap:6,color:"#f9c74f"}}>
            <Icon d={icons.gift} size={14} color="#f9c74f"/> Tukar Poin
          </div>
          <div style={{fontSize:12,color:"#8a9ba8",marginBottom:10}}>1.000 poin = Rp 1.000 diskon (sesuaikan dengan kebijakan toko)</div>
          <div style={{display:"flex",gap:8}}>
            <input type="number" value={tukarPoin} onChange={e=>setTukarPoin(e.target.value)} placeholder={`Maks ${pl.poin||0} poin`}
              style={{flex:1,padding:"9px 12px",background:"#0f1117",border:"1px solid #1e2535",borderRadius:8,color:"#e8eaf0",fontSize:13}}/>
            <button onClick={handleTukarPoin} disabled={!tukarPoin||parseInt(tukarPoin)>(pl.poin||0)}
              style={{padding:"9px 16px",background:!tukarPoin||parseInt(tukarPoin)>(pl.poin||0)?"#1e2535":"linear-gradient(135deg,#6a4f2d,#c74f)",border:"none",borderRadius:8,color:!tukarPoin||parseInt(tukarPoin)>(pl.poin||0)?"#4a5568":"#fff",fontWeight:600,fontSize:12}}>
              Tukar
            </button>
          </div>
        </div>

        {/* Riwayat belanja */}
        <div style={{background:"#141720",border:"1px solid #1e2535",borderRadius:12,overflow:"hidden",marginBottom:14}}>
          <div style={{padding:"10px 14px",borderBottom:"1px solid #1e2535",fontWeight:600,fontSize:13,color:"#52b788"}}>
            🛍️ Riwayat Belanja ({riwayat.length})
          </div>
          {riwayat.length===0
            ? <div style={{padding:20,textAlign:"center",color:"#4a5568",fontSize:13}}>Belum ada transaksi</div>
            : riwayat.map(t=>(
              <div key={t.id} style={{padding:"10px 14px",borderBottom:"1px solid #0f1117"}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                  <span style={{fontSize:11,color:"#4a5568"}}>{fmtDate(t.tanggal)}</span>
                  <span style={{fontWeight:700,color:"#52b788",fontSize:13}}>{fmt(t.total)}</span>
                </div>
                <div style={{fontSize:11,color:"#8a9ba8"}}>{t.items.map(i=>`${i.nama} x${i.qty}`).join(" · ")}</div>
                <div style={{fontSize:10,color:"#f9c74f",marginTop:3}}>+{t.poinDapat||0} poin</div>
              </div>
            ))
          }
        </div>

        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>{setForm({...pl});setView("form");}} style={{flex:1,padding:"11px",background:"#1a2535",border:"1px solid #1e2535",borderRadius:10,color:"#8a9ba8",fontWeight:600,fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <Icon d={icons.edit} size={14}/> Edit
          </button>
          <button onClick={()=>hapusPelanggan(pl.id)} style={{flex:1,padding:"11px",background:"#2e1a1a",border:"1px solid #6a2d2d",borderRadius:10,color:"#e57373",fontWeight:600,fontSize:13,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <Icon d={icons.trash} size={14}/> Hapus
          </button>
        </div>
      </div>
    );
  }

  // ── Form tambah/edit ──
  if(view==="form") return (
    <div className="fade" style={{padding:16}}>
      <button onClick={()=>setView(form?.id?"detail":"list")} style={{background:"none",border:"none",color:"#52b788",fontSize:13,fontWeight:600,marginBottom:14,display:"flex",alignItems:"center",gap:6,padding:0}}>
        ← Kembali
      </button>
      <div style={{background:"#141720",border:"1px solid #2d6a4f",borderRadius:14,padding:16}}>
        <div style={{fontWeight:600,marginBottom:14,color:"#52b788",fontSize:15}}>{form?.id?"Edit Pelanggan":"Pelanggan Baru"}</div>
        {[
          {label:"Nama Lengkap *",key:"nama",type:"text",placeholder:"mis: Budi Santoso"},
          {label:"No. Telepon",key:"telepon",type:"tel",placeholder:"mis: 08123456789"},
          {label:"Alamat",key:"alamat",type:"text",placeholder:"mis: Jl. Mawar No. 5"},
          {label:"Catatan",key:"catatan",type:"text",placeholder:"mis: Pelanggan VIP"},
        ].map(f=>(
          <div key={f.key} style={{marginBottom:12}}>
            <label style={{fontSize:11,color:"#8a9ba8",display:"block",marginBottom:4}}>{f.label}</label>
            <input type={f.type} value={form?.[f.key]||""} onChange={e=>setForm(x=>({...x,[f.key]:e.target.value}))} placeholder={f.placeholder}
              style={{width:"100%",padding:"9px 12px",background:"#0f1117",border:"1px solid #1e2535",borderRadius:8,color:"#e8eaf0",fontSize:13}}/>
          </div>
        ))}
        {form?.id&&(
          <div style={{marginBottom:12}}>
            <label style={{fontSize:11,color:"#8a9ba8",display:"block",marginBottom:4}}>Poin Saat Ini</label>
            <input type="number" value={form.poin||0} onChange={e=>setForm(x=>({...x,poin:parseInt(e.target.value)||0}))}
              style={{width:"100%",padding:"9px 12px",background:"#0f1117",border:"1px solid #1e2535",borderRadius:8,color:"#e8eaf0",fontSize:13}}/>
          </div>
        )}
        <div style={{display:"flex",gap:8,marginTop:4}}>
          <button onClick={()=>setView(form?.id?"detail":"list")} style={{flex:1,padding:"11px",background:"#1e2535",border:"none",borderRadius:8,color:"#8a9ba8",fontWeight:600,fontSize:13}}>Batal</button>
          <button onClick={savePelanggan} style={{flex:2,padding:"11px",background:"linear-gradient(135deg,#2d6a4f,#52b788)",border:"none",borderRadius:8,color:"#fff",fontWeight:700,fontSize:13}}>Simpan</button>
        </div>
      </div>
    </div>
  );

  // ── List pelanggan ──
  return (
    <div className="fade" style={{padding:16}}>
      {/* Ringkasan */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
        {[
          {label:"Total",val:state.pelanggan.length,color:"#52b788"},
          {label:"Gold+",val:state.pelanggan.filter(p=>(p.poin||0)>=2000).length,color:"#f9c74f"},
          {label:"Aktif",val:state.pelanggan.filter(p=>(p.jumlahTransaksi||0)>0).length,color:"#64b5f6"},
        ].map(s=>(
          <div key={s.label} style={{background:"#141720",border:"1px solid #1e2535",borderRadius:10,padding:"10px",textAlign:"center"}}>
            <div style={{fontSize:18,fontWeight:700,color:s.color}}>{s.val}</div>
            <div style={{fontSize:10,color:"#4a5568",marginTop:2}}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <div style={{flex:1,display:"flex",alignItems:"center",background:"#141720",border:"1px solid #1e2535",borderRadius:10,padding:"8px 12px",gap:8}}>
          <Icon d={icons.search} size={15} color="#4a5568"/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Cari nama / telepon…" style={{flex:1,background:"none",border:"none",color:"#e8eaf0",fontSize:13}}/>
        </div>
        <button onClick={()=>{setForm({nama:"",telepon:"",alamat:"",catatan:"",poin:0});setView("form");}}
          style={{padding:"8px 14px",background:"linear-gradient(135deg,#2d6a4f,#52b788)",border:"none",borderRadius:10,color:"#fff",display:"flex",alignItems:"center",gap:6,fontWeight:600,fontSize:13}}>
          <Icon d={icons.plus} size={15} color="#fff"/> Tambah
        </button>
      </div>

      {filtered.length===0 ? (
        <div style={{textAlign:"center",color:"#4a5568",padding:40,fontSize:13}}>
          {state.pelanggan.length===0?"Belum ada pelanggan. Klik Tambah untuk mulai.":"Pelanggan tidak ditemukan"}
        </div>
      ) : filtered.map(pl=>{
        const {tier,color,bg}=tierInfo(pl.poin||0);
        return (
          <button key={pl.id} onClick={()=>{setSelected(pl);setView("detail");}}
            style={{width:"100%",background:"#141720",border:"1px solid #1e2535",borderRadius:12,padding:"12px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:12,textAlign:"left"}}>
            <div style={{width:40,height:40,background:"linear-gradient(135deg,#2d6a4f,#52b788)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,color:"#fff",flexShrink:0}}>
              {pl.nama[0].toUpperCase()}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:600,fontSize:14,marginBottom:2}}>{pl.nama}</div>
              <div style={{fontSize:11,color:"#4a5568"}}>{pl.telepon||"—"} · {pl.jumlahTransaksi||0}x transaksi</div>
              <div style={{fontSize:11,color:"#52b788",marginTop:2}}>{fmt(pl.totalBelanja||0)}</div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontSize:10,fontWeight:600,color,background:bg,padding:"2px 8px",borderRadius:10,marginBottom:4}}>{tier}</div>
              <div style={{fontSize:12,color:"#f9c74f",fontWeight:600}}>⭐ {pl.poin||0}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUK
// ═══════════════════════════════════════════════════════════════════════════════
function Produk({state,dispatch}) {
  const [form,setForm]=useState(null);
  const [search,setSearch]=useState("");
  const save=async()=>{
    if(!form.nama||!form.harga) return;
    await dispatch("PRODUK_UPSERT",{...form,id:form.id||uid(),harga:parseInt(form.harga)||0,stok:parseInt(form.stok)||0,updatedAt:Date.now()});
    setForm(null);
  };
  const filtered=state.produk.filter(p=>p.nama.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="fade" style={{padding:16}}>
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <div style={{flex:1,display:"flex",alignItems:"center",background:"#141720",border:"1px solid #1e2535",borderRadius:10,padding:"8px 12px",gap:8}}>
          <Icon d={icons.search} size={15} color="#4a5568"/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Cari produk…" style={{flex:1,background:"none",border:"none",color:"#e8eaf0",fontSize:13}}/>
        </div>
        <button onClick={()=>setForm({nama:"",harga:"",stok:"",kategori:"",satuan:"pcs"})} style={{padding:"8px 14px",background:"linear-gradient(135deg,#2d6a4f,#52b788)",border:"none",borderRadius:10,color:"#fff",display:"flex",alignItems:"center",gap:6,fontWeight:600,fontSize:13}}>
          <Icon d={icons.plus} size={15} color="#fff"/> Tambah
        </button>
      </div>
      {form&&(
        <div style={{background:"#141720",border:"1px solid #2d6a4f",borderRadius:14,padding:16,marginBottom:14}}>
          <div style={{fontWeight:600,marginBottom:12,color:"#52b788"}}>{form.id?"Edit Produk":"Produk Baru"}</div>
          {[{label:"Nama Produk",key:"nama",type:"text"},{label:"Harga (Rp)",key:"harga",type:"number"},{label:"Stok Awal",key:"stok",type:"number"},{label:"Kategori",key:"kategori",type:"text"},{label:"Satuan",key:"satuan",type:"text"}].map(f=>(
            <div key={f.key} style={{marginBottom:10}}>
              <label style={{fontSize:11,color:"#8a9ba8",display:"block",marginBottom:4}}>{f.label}</label>
              <input type={f.type} value={form[f.key]||""} onChange={e=>setForm(x=>({...x,[f.key]:e.target.value}))}
                style={{width:"100%",padding:"9px 12px",background:"#0f1117",border:"1px solid #1e2535",borderRadius:8,color:"#e8eaf0",fontSize:13}}/>
            </div>
          ))}
          <div style={{display:"flex",gap:8,marginTop:4}}>
            <button onClick={()=>setForm(null)} style={{flex:1,padding:"10px",background:"#1e2535",border:"none",borderRadius:8,color:"#8a9ba8",fontWeight:600,fontSize:13}}>Batal</button>
            <button onClick={save} style={{flex:2,padding:"10px",background:"linear-gradient(135deg,#2d6a4f,#52b788)",border:"none",borderRadius:8,color:"#fff",fontWeight:700,fontSize:13}}>Simpan</button>
          </div>
        </div>
      )}
      {filtered.map(p=>(
        <div key={p.id} style={{background:"#141720",border:"1px solid #1e2535",borderRadius:12,padding:"12px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:10}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:14}}>{p.nama}</div>
            <div style={{fontSize:11,color:"#52b788",marginTop:2}}>{p.kategori} · {p.satuan}</div>
            <div style={{fontSize:13,color:"#52b788",fontWeight:700,marginTop:4}}>{fmt(p.harga)}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:12,color:p.stok<5?"#e57373":"#4a5568"}}>Stok: {p.stok}</div>
            <div style={{display:"flex",gap:6,marginTop:6}}>
              <button onClick={()=>setForm({...p})} style={{padding:"5px 10px",background:"#1a2535",border:"1px solid #1e2535",borderRadius:6,color:"#8a9ba8"}}><Icon d={icons.edit} size={13}/></button>
              <button onClick={()=>dispatch("PRODUK_DEL",{id:p.id})} style={{padding:"5px 10px",background:"#2e1a1a",border:"1px solid #6a2d2d",borderRadius:6,color:"#e57373"}}><Icon d={icons.trash} size={13}/></button>
            </div>
          </div>
        </div>
      ))}
      {filtered.length===0&&<div style={{textAlign:"center",color:"#4a5568",padding:40,fontSize:13}}>Belum ada produk</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STOK
// ═══════════════════════════════════════════════════════════════════════════════
function Stok({state,dispatch}) {
  const [adj,setAdj]=useState({});
  const sorted=[...state.produk].sort((a,b)=>a.stok-b.stok);
  return (
    <div className="fade" style={{padding:16}}>
      <div style={{background:"#141720",border:"1px solid #1e2535",borderRadius:12,padding:"10px 14px",marginBottom:14,display:"flex",gap:12}}>
        {[{label:"Total Produk",val:state.produk.length,color:"#52b788"},{label:"Menipis (<5)",val:state.produk.filter(p=>p.stok<5&&p.stok>0).length,color:"#f9c74f"},{label:"Habis",val:state.produk.filter(p=>p.stok===0).length,color:"#e57373"}].map(s=>(
          <div key={s.label} style={{flex:1,textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:700,color:s.color}}>{s.val}</div>
            <div style={{fontSize:10,color:"#4a5568",marginTop:2,lineHeight:1.3}}>{s.label}</div>
          </div>
        ))}
      </div>
      {sorted.map(p=>(
        <div key={p.id} style={{background:"#141720",border:`1px solid ${p.stok===0?"#6a2d2d":p.stok<5?"#6a5a2d":"#1e2535"}`,borderRadius:12,padding:"12px 14px",marginBottom:8}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
            <div><div style={{fontWeight:600,fontSize:14}}>{p.nama}</div><div style={{fontSize:11,color:"#8a9ba8"}}>{p.kategori}</div></div>
            <div style={{textAlign:"right"}}>
              <span style={{fontSize:20,fontWeight:700,color:p.stok===0?"#e57373":p.stok<5?"#f9c74f":"#52b788"}}>{p.stok}</span>
              <div style={{fontSize:10,color:"#4a5568"}}>{p.satuan}</div>
            </div>
          </div>
          {p.stok<5&&<div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:p.stok===0?"#e57373":"#f9c74f",background:p.stok===0?"#2e1a1a":"#2e2a1a",padding:"4px 8px",borderRadius:6,marginBottom:8}}><Icon d={icons.warning} size={11} color="currentColor"/> {p.stok===0?"Stok Habis!":"Stok Menipis"}</div>}
          <div style={{display:"flex",gap:6}}>
            <input type="number" value={adj[p.id]||""} onChange={e=>setAdj(a=>({...a,[p.id]:e.target.value}))} placeholder="±jumlah"
              style={{flex:1,padding:"8px 10px",background:"#0f1117",border:"1px solid #1e2535",borderRadius:8,color:"#e8eaf0",fontSize:12}}/>
            <button onClick={async()=>{const d=parseInt(adj[p.id]||0);if(!d)return;await dispatch("STOK_ADJ",{id:p.id,delta:d});setAdj(a=>({...a,[p.id]:""}));}}
              style={{padding:"8px 14px",background:"linear-gradient(135deg,#2d6a4f,#52b788)",border:"none",borderRadius:8,color:"#fff",fontWeight:600,fontSize:12}}>Update</button>
          </div>
        </div>
      ))}
      {sorted.length===0&&<div style={{textAlign:"center",color:"#4a5568",padding:40,fontSize:13}}>Belum ada produk</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAPORAN
// ═══════════════════════════════════════════════════════════════════════════════
function Laporan({state}) {
  const [period,setPeriod]=useState("today");
  const now=new Date();
  const filtered=state.transaksi.filter(t=>{
    const d=new Date(t.tanggal);
    if(period==="today") return d.toDateString()===now.toDateString();
    if(period==="week")  return now-d<7*86400000;
    if(period==="month") return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
    return true;
  });
  const totalPendapatan=filtered.reduce((s,t)=>s+t.total,0);
  const itemTerjual=filtered.reduce((s,t)=>s+t.items.reduce((ss,i)=>ss+i.qty,0),0);
  const itemCount={};
  filtered.forEach(t=>t.items.forEach(i=>{itemCount[i.nama]=(itemCount[i.nama]||0)+i.qty;}));
  const bestSeller=Object.entries(itemCount).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const withPelanggan=filtered.filter(t=>t.pelangganId).length;

  return (
    <div className="fade" style={{padding:16}}>
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        {[{k:"today",l:"Hari Ini"},{k:"week",l:"7 Hari"},{k:"month",l:"Bulan Ini"},{k:"all",l:"Semua"}].map(p=>(
          <button key={p.k} onClick={()=>setPeriod(p.k)} style={{flex:1,padding:"7px 4px",borderRadius:8,border:"1px solid",borderColor:period===p.k?"#52b788":"#1e2535",background:period===p.k?"#1a2e23":"transparent",color:period===p.k?"#52b788":"#4a5568",fontSize:11,fontWeight:600}}>{p.l}</button>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
        {[
          {label:"Total Pendapatan",val:fmt(totalPendapatan),color:"#52b788"},
          {label:"Jumlah Transaksi",val:filtered.length,color:"#64b5f6"},
          {label:"Item Terjual",val:itemTerjual,color:"#f9c74f"},
          {label:"Transaksi Member",val:withPelanggan,color:"#ce93d8"},
        ].map(s=>(
          <div key={s.label} style={{background:"#141720",border:"1px solid #1e2535",borderRadius:12,padding:"12px 14px"}}>
            <div style={{fontSize:10,color:"#4a5568",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.5px"}}>{s.label}</div>
            <div style={{fontSize:18,fontWeight:700,color:s.color}}>{s.val}</div>
          </div>
        ))}
      </div>
      {bestSeller.length>0&&(
        <div style={{background:"#141720",border:"1px solid #1e2535",borderRadius:12,padding:"12px 14px",marginBottom:14}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:10,color:"#52b788"}}>🏆 Produk Terlaris</div>
          {bestSeller.map(([nama,qty],i)=>(
            <div key={nama} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <div style={{width:22,height:22,borderRadius:6,background:i===0?"#2d6a4f":"#1e2535",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:i===0?"#52b788":"#4a5568"}}>{i+1}</div>
              <div style={{flex:1,fontSize:13}}>{nama}</div>
              <div style={{fontSize:12,color:"#52b788",fontWeight:600}}>{qty} terjual</div>
            </div>
          ))}
        </div>
      )}
      <div style={{background:"#141720",border:"1px solid #1e2535",borderRadius:12,overflow:"hidden"}}>
        <div style={{padding:"10px 14px",borderBottom:"1px solid #1e2535",fontWeight:600,fontSize:13,color:"#52b788",display:"flex",alignItems:"center",gap:6}}>
          <Icon d={icons.receipt} size={14} color="#52b788"/> Riwayat Transaksi
        </div>
        {filtered.length===0
          ? <div style={{padding:24,textAlign:"center",color:"#4a5568",fontSize:13}}>Belum ada transaksi</div>
          : filtered.map(t=>(
            <div key={t.id} style={{padding:"10px 14px",borderBottom:"1px solid #0f1117"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <div>
                  <span style={{fontSize:11,color:"#4a5568"}}>{fmtDate(t.tanggal)}</span>
                  {t.pelangganNama&&<span style={{fontSize:10,color:"#ce93d8",marginLeft:6}}>👤 {t.pelangganNama}</span>}
                </div>
                <span style={{fontWeight:700,color:"#52b788",fontSize:13}}>{fmt(t.total)}</span>
              </div>
              <div style={{fontSize:11,color:"#8a9ba8"}}>{t.items.map(i=>`${i.nama} x${i.qty}`).join(" · ")}</div>
            </div>
          ))
        }
      </div>
    </div>
  );
}
