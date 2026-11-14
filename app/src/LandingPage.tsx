/* Layout and copy carried over from the earlier Pacifica frontend (gks2022004/nerf@00fe59b,
   frontend/src/LandingPage.tsx), copy updated for NEAR. The graphics are new: live ASCII scenes
   (src/landing/ascii.ts) in place of the earlier SVG line art. */
import { useRef, useState } from 'react';
import { useMountEffect } from './hooks/useMountEffect';
import { ArrowRight, Sun, Moon } from 'lucide-react';
import AsciiCanvas from './landing/AsciiCanvas';
import Band, { BAND_H } from './landing/Band';
import { paintDivider, paintHero, paintLock, paintOrbit, paintPayoff, paintRidges } from './landing/ascii';
import { useThemeStore } from './theme';


/* ── Constants ── */
/* Accent per theme: NEAR green on white (light) and on black (dark). `text` must read on the
   page background; `fill` carries `ink` on top of it. */
const ACCENTS = {
  light: { text:'#117a45', fill:'#78f0a0', ink:'#172325', art:'47,179,106' },
  dark:  { text:'#78f0a0', fill:'#78f0a0', ink:'#172325', art:'120,240,160' },
};
const DISPLAY = "'Satoshi', system-ui, sans-serif";
const BODY = "'Satoshi', system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, monospace";

/* ── Theme definitions ── */
type Theme = {
  bg: string; ink: string; text: string; muted: string; dim: string; ghost: string;
  border: string; bannerBg: string; bannerText: string; artBase: string; grain: number;
  partnerGhost: string; footerDim: string;
};

const LIGHT: Theme = {
  bg:'#fff', ink:'#000', text:'#000', muted:'#000', dim:'#000', ghost:'#000',
  border:'#000', bannerBg:'#000', bannerText:'#fff', artBase:'0,0,0',
  grain:0.018, partnerGhost:'#000', footerDim:'#000',
};

const DARK: Theme = {
  bg:'#080808', ink:'#fff', text:'#fff', muted:'#fff', dim:'#fff', ghost:'#fff',
  border:'#fff', bannerBg:'#fff', bannerText:'#000', artBase:'255,255,255',
  grain:0.012, partnerGhost:'#fff', footerDim:'#fff',
};

/* ═══════════════════════════════════════════════════════
   Graphics: ASCII scenes, drawn in the page's mono font and colours
═══════════════════════════════════════════════════════ */
/** Colours as "r,g,b" for the current theme. */
type Art = { ink: string; accent: string; dark: boolean };

/** A strip of two passing waves between sections. */
function WaveDivider({ height = 36, art }: { height?: number; art: Art }) {
  return <AsciiCanvas scene={paintDivider} ink={art.ink} accent={art.accent} dark={art.dark} fontPx={10} offset={height} style={{ width:'100%', height, alignItems:'center' }}/>;
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
  { scene:paintOrbit, title:'Everlasting Options', desc:'No expiry, no rollovers. Positions persist with continuous funding.' },
  { scene:paintRidges, title:'Real-time Greeks', desc:'Delta and gamma on every quote, signed by the pricing agent.' },
  { scene:paintPayoff, title:'Multi-Leg Strategies', desc:'Straddles, strangles, spreads and risk reversals in one transaction.' },
  { scene:paintLock, title:'Non-Custodial', desc:'A NEAR contract holds the funds. Withdrawals go only to you.' },
];

/* ═══════════════════════════════════════════════════════
   LANDING PAGE
═══════════════════════════════════════════════════════ */
export default function LandingPage() {
  const { mode, toggle } = useThemeStore();

  const t = mode === 'light' ? LIGHT : DARK;
  const acc = ACCENTS[mode];
  const art: Art = { ink: t.artBase, accent: acc.art, dark: mode === 'dark' };
  // Smaller characters on a phone, so the hero's solid keeps its detail at that width.
  const [heroFont] = useState(() => (window.innerWidth < 640 ? 8 : 10));

  return (
    <div style={{ background:t.bg, minHeight:'100vh', fontFamily:BODY, color:t.text, transition:'background 0.4s, color 0.4s', overflowX:'hidden' }}>

      {/* Grain */}
      <div aria-hidden="true" style={{
        position:'fixed', inset:0, zIndex:9999, pointerEvents:'none', opacity:t.grain,
        backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        backgroundRepeat:'repeat', backgroundSize:256,
      }}/>

      <Band line={t.border}/>

      {/* Contained frame */}
      <div style={{
        maxWidth:1060, margin:'0 auto', position:'relative',
        borderLeft:`1px solid ${t.border}`, borderRight:`1px solid ${t.border}`,
        background:t.bg, transition:'background 0.4s, border-color 0.4s',
      }}>

        {/* NAV */}
        <nav style={{ position:'relative', display:'flex', alignItems:'stretch', height:58, borderBottom:`1px solid ${t.border}`, transition:'border-color 0.4s' }}>
          {/* The rule under the nav runs on past the frame to the edges of the window. */}
          <div aria-hidden="true" style={{ position:'absolute', left:'50%', bottom:-1, width:'100vw', height:1, transform:'translateX(-50%)', background:t.border, pointerEvents:'none', transition:'background 0.4s' }}/>
          <a href="#/" style={{ display:'flex', alignItems:'center', gap:10, textDecoration:'none', padding:'0 32px' }}>
            <img src="/logo.png?v=green" alt="2Options" style={{ width:24, height:24, borderRadius:3 }}/>
            <span style={{ fontFamily:DISPLAY, fontSize:18, fontWeight:700, letterSpacing:'-0.03em', color:t.text, transition:'color 0.4s' }}>2Options</span>
          </a>
          <div style={{ flex:1 }}/>
          {/* Each control is a cell of the frame, divided from the next by a rule. */}
          <button onClick={toggle} className="theme-tog" aria-label="Toggle theme" style={{
            background:'none', border:'none', borderLeft:`1px solid ${t.border}`, borderRadius:0,
            width:58, display:'flex', alignItems:'center', justifyContent:'center',
            cursor:'pointer', color:t.muted, transition:'all 0.3s',
          }}>
            {mode === 'light' ? <Moon size={15}/> : <Sun size={15}/>}
          </button>
          <a href="#/trade" className="launch-btn" style={{
            fontFamily:MONO, fontSize:12, fontWeight:600, letterSpacing:'0.04em',
            padding:'0 28px', borderRadius:0, textDecoration:'none',
            borderLeft:`1px solid ${t.border}`, color:t.ink, background:'transparent', transition:'all 0.3s',
            display:'inline-flex', alignItems:'center', gap:8,
          }}>Launch app <ArrowRight size={13} strokeWidth={2.5}/></a>
        </nav>

        {/* HERO */}
        <section style={{ position:'relative', minHeight:`calc(100vh - ${58 + BAND_H + 1}px)`, overflow:'hidden' }}>
          {/* An infinity sign as a lit solid, turning under the headline, drawn in characters */}
          <AsciiCanvas scene={paintHero} ink={art.ink} accent={art.accent} dark={art.dark} fontPx={heroFont} interactive
            style={{ position:'absolute', inset:0 }}/>

          {/* Content */}
          <div style={{ position:'relative', zIndex:2, padding:'14vh 32px 0', textAlign:'center' }}>
            <FadeIn>
              <h1 style={{ fontFamily:DISPLAY, fontSize:'clamp(40px,6.6vw,80px)', fontWeight:500, letterSpacing:'-0.045em', lineHeight:1.02, margin:'0 0 22px', color:t.ink, transition:'color 0.4s' }}>
                The Everlasting
                <br/><span style={mode === 'light'
                  ? { background:`linear-gradient(transparent 56%, ${acc.fill} 56%, ${acc.fill} 92%, transparent 92%)`, padding:'0 6px' }
                  : { color:acc.text }}>Options</span> Protocol
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

        <WaveDivider art={art}/>

        {/* DARK BANNER */}
        <section style={{
          background:t.bannerBg, padding:'34px 32px', textAlign:'center',
          borderTop:`1px solid ${t.border}`, borderBottom:`1px solid ${t.border}`,
          transition:'all 0.4s',
        }}>
          <FadeIn>
            <p style={{ fontFamily:DISPLAY, fontSize:'clamp(15px,2vw,20px)', fontWeight:500, letterSpacing:'-0.02em', color:t.bannerText, margin:0, transition:'color 0.4s' }}>
              Trade Options Without Expiry.
            </p>
          </FadeIn>
        </section>

        {/* PROTOCOL */}
        <section style={{ padding:'72px 40px', textAlign:'center' }}>
          <FadeIn>
            <span style={{ fontFamily:MONO, fontSize:10, color:acc.text, letterSpacing:'0.22em', display:'block', marginBottom:18 }}>2Options</span>
            <p style={{ fontFamily:DISPLAY, fontSize:'clamp(15px,1.7vw,18px)', fontWeight:400, letterSpacing:'-0.01em', color:t.muted, lineHeight:1.85, margin:'0 auto 32px', maxWidth:520, transition:'color 0.4s' }}>
              Everlasting options give traders long-term options exposure without the effort, risk, or expense of rolling positions.
            </p>
          </FadeIn>
          <FadeIn delay={60}>
            <p style={{ fontSize:14, color:t.dim, lineHeight:1.7, maxWidth:460, margin:'0 auto', transition:'color 0.4s' }}>
              Since multiple expiries are no longer required, liquidity will be less fragmented.
            </p>
          </FadeIn>
        </section>

        <WaveDivider height={30} art={art}/>

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
                  <div style={{ marginBottom:16 }}>
                    <AsciiCanvas scene={f.scene} ink={art.ink} accent={art.accent} dark={art.dark} fontPx={9} offset={i * 1.7}
                      style={{ width:'min(100%, 360px)', height:176, margin:'0 auto', alignItems:'center' }}/>
                  </div>
                  <h3 style={{ fontFamily:DISPLAY, fontSize:17, fontWeight:500, letterSpacing:'-0.02em', color:t.ink, margin:'0 0 8px', transition:'color 0.4s' }}>{f.title}</h3>
                  <p style={{ fontSize:13, color:t.dim, lineHeight:1.6, margin:0, transition:'color 0.4s' }}>{f.desc}</p>
                </div>
              ))}
            </div>
          </FadeIn>
        </section>

        <WaveDivider height={30} art={art}/>

        {/* CTA */}
        <section style={{ padding:'32px 32px 72px', textAlign:'center' }}>
          <FadeIn>
            <h2 style={{ fontFamily:DISPLAY, fontSize:'clamp(28px,4.4vw,46px)', fontWeight:500, letterSpacing:'-0.04em', lineHeight:1.05, margin:'0 0 16px', color:t.ink, transition:'color 0.4s' }}>
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

        <WaveDivider height={45} art={art}/>

        {/* FOOTER */}
        <footer style={{ borderTop:`1px solid ${t.border}`, padding:'28px 32px', textAlign:'center', transition:'border-color 0.4s' }}>
          <a href="#/" style={{ display:'inline-flex', alignItems:'center', gap:8, textDecoration:'none', marginBottom:14 }}>
            <img src="/logo.png?v=green" alt="" style={{ width:16, height:16, opacity:0.5 }}/>
            <span style={{ fontFamily:DISPLAY, fontSize:13, fontWeight:700, color:t.ghost, letterSpacing:'-0.02em', transition:'color 0.4s' }}>2Options</span>
          </a>
          <p style={{ fontFamily:MONO, fontSize:9, color:t.footerDim, marginTop:14, opacity:0.6, transition:'color 0.4s' }}>&copy; {new Date().getFullYear()} 2Options Protocol</p>
        </footer>

      </div>

      <Band edge="bottom" line={t.border}/>

      {/* STYLES */}
      <style>{`
        html { scroll-behavior:smooth; }
        .nav-link:hover { color:${acc.text} !important; }
        .launch-btn:hover { background:${acc.fill} !important; color:${acc.ink} !important; }
        .theme-tog:hover { color:${acc.text} !important; }
        .cta-btn:hover { background:${acc.fill} !important; color:${acc.ink} !important; }
        .partner:hover { color:${acc.text} !important; }
        .f-link:hover { color:${acc.text} !important; }
        @media(max-width:640px) {
          .lp-nav .nav-link { display:none; }
          .feat-grid { grid-template-columns:1fr !important; }
          .feat-grid > div { border-right:none !important; }
        }
      `}</style>
    </div>
  );
}
