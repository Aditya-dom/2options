/* Carried over from the earlier Pacifica frontend (gks2022004/nerf@00fe59b, frontend/src/LandingPage.tsx); copy updated for NEAR. */
import { useRef, useState } from 'react';
import { useMountEffect } from './hooks/useMountEffect';
import { ArrowRight, Sun, Moon } from 'lucide-react';
import { useThemeStore } from './theme';


/* ── Constants ── */
const CYAN = '#00e5ff';
const SERIF = "'DM Serif Display', Georgia, serif";
const BODY = "'Outfit', system-ui, sans-serif";
const MONO = "'JetBrains Mono', monospace";

/* ── Theme definitions ── */
type Theme = {
  bg: string; ink: string; text: string; muted: string; dim: string; ghost: string;
  border: string; bannerBg: string; bannerText: string; artBase: string; grain: number;
  partnerGhost: string; footerDim: string;
};

const LIGHT: Theme = {
  bg:'#faf8f3', ink:'#000', text:'#000', muted:'#000', dim:'#000', ghost:'#000',
  border:'#000', bannerBg:'#000', bannerText:'#fff', artBase:'0,0,0',
  grain:0.018, partnerGhost:'#000', footerDim:'#000',
};

const DARK: Theme = {
  bg:'#080808', ink:'#fff', text:'#fff', muted:'#fff', dim:'#fff', ghost:'#fff',
  border:'#fff', bannerBg:'#fff', bannerText:'#000', artBase:'255,255,255',
  grain:0.012, partnerGhost:'#fff', footerDim:'#fff',
};

/* ═══════════════════════════════════════════════════════
   Wave utilities
═══════════════════════════════════════════════════════ */
type Pt = [number, number];
function wp(pts: Pt[]): string {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i + 2 < pts.length; i += 3)
    d += ` C${pts[i][0]},${pts[i][1]} ${pts[i+1][0]},${pts[i+1][1]} ${pts[i+2][0]},${pts[i+2][1]}`;
  return d;
}
function offY(pts: Pt[], dy: number): Pt[] { return pts.map(([x, y]) => [x, y + dy]); }

/* ── Hero wave crests ── */
const CRESTS: { pts: Pt[]; n: number; gap: number; accent?: boolean; o: number; sw: number }[] = [
  { pts:[[-20,500],[140,468],[280,510],[420,478],[560,448],[700,502],[840,470],[920,458],[960,485]], n:3, gap:7, o:0.5, sw:0.7 },
  { pts:[[-20,540],[120,500],[260,548],[420,512],[580,475],[720,538],[860,502],[930,488],[960,520]], n:3, gap:7, o:0.55, sw:0.9 },
  { pts:[[-20,580],[100,532],[260,595],[430,548],[590,505],[730,578],[870,538],[940,522],[960,555]], n:4, gap:6, o:0.6, sw:1.1 },
  { pts:[[-20,620],[80,565],[240,635],[420,582],[600,528],[750,618],[880,568],[945,552],[960,588]], n:4, gap:6, o:0.5, sw:1.3, accent:true },
  { pts:[[-20,660],[65,600],[225,670],[410,613],[590,557],[745,650],[878,595],[948,580],[960,617]], n:5, gap:5, o:0.65, sw:1.5 },
  { pts:[[-20,700],[50,638],[210,712],[395,652],[575,592],[738,688],[872,630],[945,615],[960,652]], n:5, gap:5, o:0.75, sw:1.8 },
  { pts:[[-20,735],[60,695],[220,745],[400,700],[580,655],[740,730],[870,680],[945,667],[960,700]], n:4, gap:5, o:0.6, sw:1.2 },
];

const CURLS = [
  'M420,648 C410,632 416,618 434,624 C440,626 437,638 428,644',
  'M745,682 C735,666 740,652 758,658 C764,660 761,672 752,678',
  'M410,704 C398,686 405,672 424,678 C432,681 428,694 418,700',
  'M590,648 C582,638 587,628 600,632 C606,634 602,644 594,648',
];

const SPRAY = [
  [425,616,2.2,0.7],[436,610,1.2,0.6],[752,650,2.5,0.75],[742,644,1,0.55],
  [415,670,2.8,0.8],[398,666,1,0.55],[595,625,1.8,0.65],[232,700,2,0.7],[875,685,1.5,0.6],
] as const;

const RAYS = Array.from({ length: 55 }, (_, i) => {
  const a = (Math.PI * 0.06) + (i / 55) * (Math.PI * 0.88);
  return { x2: 480 + Math.cos(a) * 850, y2: 740 - Math.sin(a) * 850 };
});

/* ═══════════════════════════════════════════════════════
   Feature illustrations — accept ink/accent color fns
═══════════════════════════════════════════════════════ */
type CF = (o: number) => string;

function InfinityArt({ ink, acc }: { ink: CF; acc: CF }) {
  return (
    <svg viewBox="0 0 130 60" width="115" height="53" className="f-art f-float">
      <path d="M16,30 C16,10 38,10 65,30 C92,50 114,50 114,30 C114,10 92,10 65,30 C38,50 16,50 16,30" fill="none" stroke={ink(0.75)} strokeWidth="1.8"/>
      <path d="M20,30 C20,14 40,14 65,30 C90,46 110,46 110,30 C110,14 90,14 65,30 C40,46 20,46 20,30" fill="none" stroke={ink(0.55)} strokeWidth="1.1"/>
      <path d="M24,30 C24,18 42,18 65,30 C88,42 106,42 106,30 C106,18 88,18 65,30 C42,42 24,42 24,30" fill="none" stroke={acc(0.7)} strokeWidth="0.8"/>
      <circle cx="65" cy="30" r="2.5" fill={acc(0.8)}/><circle cx="16" cy="30" r="1.5" fill={ink(0.6)}/><circle cx="114" cy="30" r="1.5" fill={ink(0.6)}/>
    </svg>
  );
}
function SurfaceArt({ ink, acc }: { ink: CF; acc: CF }) {
  return (
    <svg viewBox="0 0 130 72" width="115" height="64" className="f-art f-pulse">
      <path d="M8,58 Q35,50 55,22 Q75,28 95,10 Q115,2 126,12" fill="none" stroke={ink(0.4)} strokeWidth="0.7"/>
      <path d="M8,50 Q35,42 55,17 Q75,22 95,6 Q115,-1 126,7" fill="none" stroke={ink(0.55)} strokeWidth="0.9"/>
      <path d="M8,42 Q35,34 55,12 Q75,16 95,2 Q115,-4 126,2" fill="none" stroke={ink(0.75)} strokeWidth="1.3"/>
      <path d="M8,34 Q35,26 55,7 Q75,12 95,-1 Q115,-6 126,-2" fill="none" stroke={acc(0.7)} strokeWidth="1"/>
      <path d="M8,26 Q35,20 55,3 Q75,6 95,-4 Q115,-8 126,-5" fill="none" stroke={ink(0.4)} strokeWidth="0.7"/>
      <text x="65" y="70" fill={ink(0.5)} fontSize="15" fontFamily="serif" textAnchor="middle">Δ</text>
      <circle cx="75" cy="16" r="2.5" fill={acc(0.8)}/>
    </svg>
  );
}
function ButterflyArt({ ink, acc }: { ink: CF; acc: CF }) {
  return (
    <svg viewBox="0 0 130 68" width="115" height="60" className="f-art f-sway">
      <path d="M10,48 L38,48 L65,12 L92,48 L120,48" fill="none" stroke={ink(0.75)} strokeWidth="1.7"/>
      <path d="M10,48 L38,48 L65,60 L92,48 L120,48" fill="none" stroke={ink(0.75)} strokeWidth="1.7"/>
      <path d="M16,48 L40,48 L65,18 L90,48 L114,48" fill="none" stroke={acc(0.65)} strokeWidth="1"/>
      <path d="M16,48 L40,48 L65,56 L90,48 L114,48" fill="none" stroke={acc(0.65)} strokeWidth="1"/>
      <path d="M22,48 L42,48 L65,24 L88,48 L108,48" fill="none" stroke={ink(0.4)} strokeWidth="0.7"/>
      <circle cx="65" cy="12" r="2.5" fill={acc(0.8)}/><circle cx="65" cy="60" r="2.5" fill={acc(0.8)}/>
      <circle cx="38" cy="48" r="1.5" fill={ink(0.6)}/><circle cx="92" cy="48" r="1.5" fill={ink(0.6)}/>
    </svg>
  );
}
function ShieldArt({ ink, acc }: { ink: CF; acc: CF }) {
  return (
    <svg viewBox="0 0 110 82" width="95" height="71" className="f-art f-float-b">
      <path d="M55,4 L94,22 L94,48 Q94,70 55,78 Q16,70 16,48 L16,22 Z" fill="none" stroke={ink(0.7)} strokeWidth="1.7"/>
      <path d="M55,12 L86,27 L86,46 Q86,62 55,68 Q24,62 24,46 L24,27 Z" fill="none" stroke={ink(0.5)} strokeWidth="1.1"/>
      <path d="M55,20 L78,32 L78,44 Q78,56 55,62 Q32,56 32,44 L32,32 Z" fill="none" stroke={acc(0.6)} strokeWidth="0.8"/>
      <circle cx="55" cy="40" r="6" fill="none" stroke={ink(0.45)} strokeWidth="0.8"/>
      <circle cx="55" cy="40" r="2.5" fill={acc(0.8)}/>
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════
   Wave divider
═══════════════════════════════════════════════════════ */
function WaveDivider({ height = 36, ink }: { height?: number; ink: CF }) {
  return (
    <div style={{ position:'relative', width:'100%', height, overflow:'hidden' }}>
      {[
        { o:0.5, sw:1.4, dy:0, cls:'aw-0' },
        { o:0.35, sw:0.9, dy:6, cls:'aw-1' },
        { o:0.2, sw:0.5, dy:12, cls:'aw-2' },
      ].map((w,i) => (
        <svg key={i} className={w.cls} viewBox="0 0 2880 36" preserveAspectRatio="none"
          style={{ position:'absolute', bottom:w.dy, left:0, width:'200%', height:height-w.dy }}>
          <path d="M0,18 Q360,36 720,18 Q1080,0 1440,18 Q1800,36 2160,18 Q2520,0 2880,18"
            fill="none" stroke={ink(w.o)} strokeWidth={w.sw}/>
        </svg>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   FadeIn + AnimatedStat
═══════════════════════════════════════════════════════ */
function FadeIn({ children, delay=0, y=20 }: { children:React.ReactNode; delay?:number; y?:number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [v, setV] = useState(false);
  useMountEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setV(true); obs.disconnect(); } },
      { threshold:0.1, rootMargin:'0px 0px -30px 0px' });
    obs.observe(ref.current);
    return () => obs.disconnect();
  });
  return <div ref={ref} style={{ opacity:v?1:0, transform:v?'translateY(0)':`translateY(${y}px)`, transition:`opacity 0.55s ease ${delay}ms, transform 0.55s ease ${delay}ms` }}>{children}</div>;
}


/* ── Feature data ── */
const FEATURES = [
  { Art:InfinityArt, title:'Everlasting Options', desc:'No expiry, no rollovers. Positions persist with continuous funding.' },
  { Art:SurfaceArt, title:'Real-time Greeks', desc:'Delta and gamma on every quote, signed by the pricing agent.' },
  { Art:ButterflyArt, title:'Multi-Leg Strategies', desc:'Straddles, strangles, spreads and risk reversals in one transaction.' },
  { Art:ShieldArt, title:'Non-Custodial', desc:'A NEAR contract holds the funds. Withdrawals go only to you.' },
];

/* ═══════════════════════════════════════════════════════
   LANDING PAGE
═══════════════════════════════════════════════════════ */
export default function LandingPage() {
  const { mode, toggle } = useThemeStore();

  const t = mode === 'light' ? LIGHT : DARK;
  const artInk: CF = (o) => `rgba(${t.artBase},${o})`;
  const artCyan: CF = (o) => `rgba(0,229,255,${o})`;

  return (
    <div style={{ background:t.bg, minHeight:'100vh', fontFamily:BODY, color:t.text, transition:'background 0.4s, color 0.4s' }}>

      {/* Grain */}
      <div aria-hidden="true" style={{
        position:'fixed', inset:0, zIndex:9999, pointerEvents:'none', opacity:t.grain,
        backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        backgroundRepeat:'repeat', backgroundSize:256,
      }}/>

      {/* Contained frame */}
      <div style={{
        maxWidth:1060, margin:'0 auto', position:'relative',
        borderLeft:`1px solid ${t.border}`, borderRight:`1px solid ${t.border}`,
        background:t.bg, transition:'background 0.4s, border-color 0.4s',
      }}>

        {/* NAV */}
        <nav style={{ display:'flex', alignItems:'center', padding:'0 32px', height:58, borderBottom:`1px solid ${t.border}`, transition:'border-color 0.4s' }}>
          <a href="#/" style={{ display:'flex', alignItems:'center', gap:10, textDecoration:'none' }}>
            <img src="/logo.png" alt="2options" style={{ width:24, height:24, borderRadius:3 }}/>
            <span style={{ fontFamily:MONO, fontSize:12, fontWeight:600, letterSpacing:'0.12em', color:t.text, transition:'color 0.4s' }}>2OPTIONS</span>
          </a>
          <div style={{ flex:1 }}/>
          <div className="lp-nav" style={{ display:'flex', alignItems:'center', gap:4 }}>
            <button onClick={toggle} className="theme-tog" aria-label="Toggle theme" style={{
              background:'none', border:`1px solid ${t.border}`, borderRadius:0,
              width:34, height:34, display:'flex', alignItems:'center', justifyContent:'center',
              cursor:'pointer', color:t.muted, transition:'all 0.3s', marginLeft:4,
            }}>
              {mode === 'light' ? <Moon size={14}/> : <Sun size={14}/>}
            </button>
            <a href="#/trade" className="launch-btn" style={{
              fontFamily:MONO, fontSize:11, fontWeight:600, letterSpacing:'0.04em',
              padding:'8px 18px', borderRadius:0, textDecoration:'none', marginLeft:4,
              border:`1px solid ${t.ink}`, color:t.ink, background:'transparent', transition:'all 0.3s',
              display:'inline-flex', alignItems:'center', gap:6,
            }}>Launch app <ArrowRight size={12} strokeWidth={2.5}/></a>
          </div>
        </nav>

        {/* HERO */}
        <section style={{ position:'relative', minHeight:'calc(100vh - 58px)', overflow:'hidden' }}>
          {/* Sunburst */}
          <svg aria-hidden="true" viewBox="0 0 960 750" preserveAspectRatio="xMidYMax slice"
            style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none' }}>
            {RAYS.map((r,i)=>(
              <line key={i} x1={480} y1={740} x2={r.x2} y2={r.y2} stroke={artInk(0.3)} strokeWidth="0.5"/>
            ))}
          </svg>

          {/* Wave illustration */}
          <svg viewBox="0 0 960 750" preserveAspectRatio="xMidYMax slice" aria-hidden="true"
            style={{ position:'absolute', bottom:0, left:0, width:'100%', height:'50%', pointerEvents:'none' }}>
            {CRESTS.map((c,ci)=>
              Array.from({length:c.n},(_,li)=>(
                <path key={`${ci}-${li}`} d={wp(offY(c.pts, li*c.gap))}
                  fill="none" stroke={c.accent ? artCyan(c.o) : artInk(c.o)} strokeWidth={c.sw}
                  className={ci>=4?'hero-wave':undefined}/>
              ))
            )}
            {CURLS.map((d,i)=>(
              <path key={`c${i}`} d={d} fill="none" stroke={artInk(0.7)} strokeWidth="1.1"/>
            ))}
            {SPRAY.map((s,i)=>(
              <circle key={`s${i}`} cx={s[0]} cy={s[1]} r={s[2]} fill={artInk(s[3])}/>
            ))}
          </svg>

          {/* Content */}
          <div style={{ position:'relative', zIndex:2, padding:'14vh 32px 0', textAlign:'center' }}>
            <FadeIn>
              <h1 style={{ fontFamily:SERIF, fontSize:'clamp(34px,5.8vw,62px)', fontWeight:400, letterSpacing:'-0.015em', lineHeight:1.12, margin:'0 0 22px', color:t.ink, transition:'color 0.4s' }}>
                The Everlasting
                <br/><span style={{ color:CYAN }}>Options</span> Protocol
              </h1>
            </FadeIn>
            <FadeIn delay={80}>
              <p style={{ fontSize:'clamp(14px,1.5vw,16px)', color:t.muted, lineHeight:1.7, margin:'0 auto 38px', maxWidth:400, transition:'color 0.4s', textAlign:'center' }}>
                Trade crypto options with no expiry on NEAR.
                <br/>
                Every trade settled and margined on chain.
              </p>
            </FadeIn>
          </div>
        </section>

        <WaveDivider ink={artInk}/>

        {/* DARK BANNER */}
        <section style={{
          background:t.bannerBg, padding:'34px 32px', textAlign:'center',
          borderTop:`1px solid ${t.border}`, borderBottom:`1px solid ${t.border}`,
          transition:'all 0.4s',
        }}>
          <FadeIn>
            <p style={{ fontFamily:SERIF, fontSize:'clamp(15px,2vw,20px)', fontWeight:400, fontStyle:'italic', color:t.bannerText, margin:0, transition:'color 0.4s' }}>
              Trade Options Without Expiry.
            </p>
          </FadeIn>
        </section>

        {/* PROTOCOL */}
        <section style={{ padding:'72px 40px', textAlign:'center' }}>
          <FadeIn>
            <span style={{ fontFamily:MONO, fontSize:10, color:CYAN, letterSpacing:'0.22em', display:'block', marginBottom:18 }}>2OPTIONS</span>
            <p style={{ fontFamily:SERIF, fontSize:'clamp(15px,1.7vw,18px)', fontWeight:400, fontStyle:'italic', color:t.muted, lineHeight:1.85, margin:'0 auto 32px', maxWidth:520, transition:'color 0.4s' }}>
              Everlasting options give traders long-term options exposure without the effort, risk, or expense of rolling positions.
            </p>
          </FadeIn>
          <FadeIn delay={60}>
            <p style={{ fontSize:14, color:t.dim, lineHeight:1.7, maxWidth:460, margin:'0 auto', transition:'color 0.4s' }}>
              Since multiple expiries are no longer required, liquidity will be less fragmented.
            </p>
          </FadeIn>
        </section>

        <WaveDivider height={30} ink={artInk}/>

        {/* FEATURES 2×2 */}
        <section>
          <FadeIn>
            <div className="feat-grid" style={{
              display:'grid', gridTemplateColumns:'1fr 1fr',
              borderTop:`1px solid ${t.border}`, transition:'border-color 0.4s',
            }}>
              {FEATURES.map((f,i)=>(
                <div key={f.title} style={{
                  padding:'clamp(28px,4vw,48px) clamp(18px,3vw,36px)', textAlign:'center',
                  borderRight: i%2===0 ? `1px solid ${t.border}` : 'none',
                  borderBottom: `1px solid ${t.border}`, transition:'border-color 0.4s',
                }}>
                  <div style={{ marginBottom:16 }}><f.Art ink={artInk} acc={artCyan}/></div>
                  <h3 style={{ fontFamily:SERIF, fontSize:16, fontWeight:400, color:t.ink, margin:'0 0 8px', transition:'color 0.4s' }}>{f.title}</h3>
                  <p style={{ fontSize:13, color:t.dim, lineHeight:1.6, margin:0, transition:'color 0.4s' }}>{f.desc}</p>
                </div>
              ))}
            </div>
          </FadeIn>
        </section>

        <WaveDivider height={30} ink={artInk}/>

        {/* CTA */}
        <section style={{ padding:'32px 32px 72px', textAlign:'center' }}>
          <FadeIn>
            <h2 style={{ fontFamily:SERIF, fontSize:'clamp(24px,4vw,38px)', fontWeight:400, margin:'0 0 16px', color:t.ink, transition:'color 0.4s' }}>
              Start Trading Now
            </h2>
            <p style={{ fontSize:14, color:t.dim, margin:'0 auto 30px', maxWidth:340, lineHeight:1.6, transition:'color 0.4s' }}>
              Connect a NEAR wallet and trade everlasting options on testnet.
            </p>
            <a href="#/trade" className="cta-btn" style={{
              display:'inline-flex', alignItems:'center', gap:8,
              fontFamily:MONO, fontSize:12, fontWeight:600, padding:'12px 32px', borderRadius:0,
              textDecoration:'none', background:t.ink, color:t.bg, transition:'all 0.3s', letterSpacing:'0.03em',
            }}>Launch App <ArrowRight size={14} strokeWidth={2.5}/></a>
          </FadeIn>
        </section>

        <WaveDivider height={45} ink={artInk}/>

        {/* FOOTER */}
        <footer style={{ borderTop:`1px solid ${t.border}`, padding:'28px 32px', textAlign:'center', transition:'border-color 0.4s' }}>
          <a href="#/" style={{ display:'inline-flex', alignItems:'center', gap:8, textDecoration:'none', marginBottom:14 }}>
            <img src="/logo.png" alt="" style={{ width:16, height:16, opacity:0.5 }}/>
            <span style={{ fontFamily:MONO, fontSize:10, fontWeight:600, color:t.ghost, letterSpacing:'0.1em', transition:'color 0.4s' }}>2OPTIONS</span>
          </a>
          <p style={{ fontFamily:MONO, fontSize:9, color:t.footerDim, marginTop:14, opacity:0.6, transition:'color 0.4s' }}>&copy; {new Date().getFullYear()} 2options Protocol</p>
        </footer>

      </div>

      {/* STYLES */}
      <style>{`
        html { scroll-behavior:smooth; }
        .hero-wave { animation: heroWave 5s ease-in-out infinite alternate; }
        @keyframes heroWave { 0%{transform:translateX(0) translateY(0)} 100%{transform:translateX(8px) translateY(-3px)} }
        .aw-0 { animation:awFlow 7s linear infinite; }
        .aw-1 { animation:awFlow 11s linear infinite reverse; }
        .aw-2 { animation:awFlow 16s linear infinite; }
        @keyframes awFlow { from{transform:translateX(0)} to{transform:translateX(-50%)} }
        .f-art { display:block; margin:0 auto; }
        .f-float   { animation:fF 3s ease-in-out infinite; }
        .f-pulse   { animation:fP 3s ease-in-out infinite; }
        .f-sway    { animation:fS 3.5s ease-in-out infinite; }
        .f-float-b { animation:fF 3.5s ease-in-out infinite 0.4s; }
        @keyframes fF { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
        @keyframes fP { 0%,100%{transform:scale(1)} 50%{transform:scale(1.04)} }
        @keyframes fS { 0%,100%{transform:rotate(0)} 25%{transform:rotate(2.5deg)} 75%{transform:rotate(-2.5deg)} }
        .nav-link:hover { color:${CYAN} !important; }
        .launch-btn:hover { background:${CYAN} !important; color:#000 !important; border-color:${CYAN} !important; }
        .theme-tog:hover { border-color:${CYAN} !important; color:${CYAN} !important; }
        .cta-btn:hover { background:${CYAN} !important; color:#000 !important; }
        .partner:hover { color:${CYAN} !important; }
        .f-link:hover { color:${CYAN} !important; }
        @media(max-width:640px) {
          .lp-nav .nav-link { display:none; }
          .feat-grid { grid-template-columns:1fr !important; }
          .feat-grid > div { border-right:none !important; }
        }
      `}</style>
    </div>
  );
}
