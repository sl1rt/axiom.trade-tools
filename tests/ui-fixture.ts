import { addr, context, historyToken } from './fixtures';
import { tokenUrl } from '../src/core';
import type { Chain } from '../src/types';

// Axiom's token summary: the unlabelled MC block immediately precedes Price.
export const marketCapHeader = (usd = '$47.2M', ath = '$169M') => `
  <div class="token-summary">
    <div><div id="pair-name-tooltip"><span>8d</span></div></div>
    <div><div><span class="text-increase sm:text-textPrimary text-[18px]"><span>${usd}</span></span></div></div>
    <div><span>Price</span><div><span>$0.047</span></div></div>
    <div><span>Liquidity</span><div><span>$946K</span></div></div>
    <div><span>Supply</span><button>1B</button></div>
    <span class="contents"><div><span>ATH</span><div><span><span>${ath}</span></span></div></div></span>
  </div>`;

export function axiomPage(
  chain: Chain,
  n = 1,
  brokenHistory = false,
  virtualHistory = false,
  slowHistoryMs = 0,
  empty: {
    emptyWallet?: boolean;
    emptyNoHeader?: boolean;
    transientEmptyMs?: number;
    closeDelayMs?: number;
    holdSecondHistory?: boolean;
    initialOpened?: 'Opened' | 'Opened ↑' | 'Opened ↓';
    freshWallet?: boolean;
    zeroBought?: boolean;
    searchMode?: 'missing' | 'wrong-result' | 'wrong-modal' | 'wrong-chain';
    searchDelayMs?: number;
  } = {},
): string {
  const explorer = chain === 'sol' ? 'solscan.io' : chain === 'bnb' ? 'bscscan.com' : 'rh-scan.com';
  const config = {
    chain,
    explorer,
    brokenHistory,
    virtualHistory,
    slowHistoryMs,
    ...empty,
    explorerName: chain === 'sol' ? 'Solscan' : chain === 'bnb' ? 'BSCScan' : 'RH Scan',
    wallets: [100, 101, 102, 999].map((w) => addr(chain, w)),
    tokens: Array.from({ length: 9 }, (_, i) => ({
      ...historyToken(i + 1, chain),
      url: i === 0 ? context(chain).pageUrl : tokenUrl(historyToken(i + 1, chain)),
    })),
  };
  return `<!doctype html><html><head><title>T${n} ↑ $50K | Axiom ${chain}</title><style>
  body{background:#0b0c12;color:#ddd;font:14px Arial;margin:24px}button{background:#292c38;color:white;padding:8px;border:0;cursor:pointer}a{color:#b0dbff}.text-increase{color:#6ee799}.text-decrease{color:#ef6d78}.text-textTertiary{color:#999}.text-textSecondary{color:#aaa}.text-textPrimary{color:#fff}.overflow-y-auto{overflow-y:auto}#trades{height:160px;width:640px}.trade{height:24px;display:flex;gap:16px;align-items:center}.trade button{padding:0}#modal{position:fixed;left:12px;top:130px;background:#161823;border:1px solid #555;padding:14px;width:700px;z-index:99}#positions{height:220px}.position{height:60px;min-height:60px;display:flex;gap:15px}.position>a{width:150px}.position>div{width:100px}.position span{display:block}#head{display:flex;gap:8px;margin-bottom:20px}
  </style></head><body><h1>AXIOM · UI test fixture</h1><h2>T${n}　$50K</h2><a href="https://${explorer}/${chain === 'sol' ? 'token' : 'address'}/${addr(chain, n)}">CA</a>${marketCapHeader('$50K', '$125K')}
  <button id="search">Search by token or CA /</button><section><div><button>All</button><button>Trades</button><button id="age">Age ↓</button></div><div id="trades" class="overflow-y-auto"></div></section>
  <script>
  const cfg=${JSON.stringify(config)};
  const log = value => {document.body.dataset.actions = (document.body.dataset.actions || '') + value + '|';};
  const trades = [{w:3,b:false},{w:0,b:true},{w:0,b:true},{w:1,b:true},{w:2,b:true}];
  const renderTrades = () => {
    const ascending = document.querySelector('#age').textContent.includes('↑');
    document.querySelector('#trades').innerHTML = (ascending ? trades.map((t,i)=>({...t,i})) : trades.map((t,i)=>({...t,i})).reverse()).map(t => '<div class="trade"><span class="'+(t.b?'text-increase':'text-decrease')+'">$100</span><span>$20K</span><button data-trader="'+t.w+'">Trader '+t.w+'</button><a href="https://'+cfg.explorer+'/tx/tx'+t.i+'">10d</a></div>').join('');
    document.querySelectorAll('[data-trader]').forEach(button=>{
      const firstBuy=document.createElement('i');firstBuy.className='ri-bard-fill';firstBuy.title='First Buy';firstBuy.textContent='*';button.append(firstBuy);
      if(cfg.freshWallet&&button.dataset.trader==='0'){
        const badge=document.createElement('i');badge.className='ri-leaf-line text-primaryOrange';badge.textContent='leaf';button.parentElement.append(badge);
      }
      button.onclick=()=>openWallet(Number(button.dataset.trader));
    });
  };
  document.querySelector('#age').onclick = function(){this.textContent=this.textContent.includes('↑')?'Age ↓':'Age ↑'; log(this.textContent);renderTrades();};
  function openWallet(w) {
    if(w===1)document.body.dataset.nextWalletAt=String(Date.now());
    log('wallet:'+w); const wallet=cfg.wallets[w], modal=document.createElement('div');modal.id='modal';
    modal.innerHTML='<div id="head"><button id="copy"><span>'+wallet.slice(0,4)+'...'+wallet.slice(-4)+'</span><i class="ri-file-copy-line"></i></button><button aria-label="Open in '+cfg.explorerName+'">Explorer</button><button>1d</button><button id="max">Max</button><button id="close" aria-label="Close wallet"><i class="ri-close-line"></i>×</button></div><button>Active Positions</button><button id="history">History</button><div id="history-content"></div>';
    document.body.append(modal); modal.querySelector('#copy').onclick=()=>navigator.clipboard.writeText(wallet);
    modal.querySelector('#close').onclick=()=>{
      if(cfg.closeDelayMs){
        modal.style.opacity='0';modal.dataset.closing='true';
        setTimeout(()=>{modal.remove();renderTrades();},cfg.closeDelayMs);
      }else modal.remove();
    };modal.querySelector('#max').onclick=()=>{modal.dataset.max='true';log('Max');};
    modal.querySelector('#history').onclick=()=>{
      modal.querySelector('#history').setAttribute('aria-selected','true');
      log('History:'+w); modal.querySelector('#history-content').innerHTML='<button id="opened">Opened</button><input placeholder="Search by name or address"><div id="positions" class="overflow-y-auto"></div>';
      modal.querySelector('#opened').textContent=cfg.initialOpened||'Opened';
      if(cfg.emptyWallet&&w===0){
        if(cfg.emptyNoHeader)modal.querySelector('#opened').remove();
        modal.querySelector('#positions').innerHTML='<span class="text-textTertiary">No historic positions</span>';
        document.body.dataset.historyEmptyAt=String(Date.now());return;
      }
      const render=()=>{
        const indices = cfg.virtualHistory ? [1,2,3,4,5,6,7,7,0,8] : w===2 ? [0] : w===0 ? [0,1,2] : [0,1];
        if(!modal.querySelector('#opened').textContent.includes('↑'))indices.reverse();
        const positions=modal.querySelector('#positions');
        const start=cfg.virtualHistory ? Math.floor(positions.scrollTop/60) : 0;
        const visible=cfg.virtualHistory ? indices.slice(start,start+4) : indices;
        const html=visible.map(i=>{
          const t=cfg.tokens[i], days=cfg.virtualHistory&&i===0?2.5:10-i;return '<div class="position"><a href="'+t.url+'"><img width="1" height="1" src="https://axiom.trade/images/'+t.address+'.webp"><div class="text-textPrimary">'+t.symbol+'</div><div class="text-textSecondary">'+t.name+'</div></a><div><span class="'+(cfg.brokenHistory?'unknown':'text-increase')+'">'+(cfg.brokenHistory?'???':'$100')+'</span><span class="text-textTertiary">'+(cfg.brokenHistory?'???':'<span>1M</span>')+'</span></div><div>Sold</div><div>PnL</div><div><span class="text-textSecondary">'+days+'d ago</span><span class="text-textTertiary">last TX 1d ago</span></div><div>Share</div></div>';
        }).join('');
        positions.innerHTML=cfg.virtualHistory ? '<div style="height:'+indices.length*60+'px;position:relative"><div style="position:absolute;top:'+start*60+'px;width:100%">'+html+'</div></div>' : html;
        if(cfg.zeroBought&&w===0)positions.querySelectorAll('.position').forEach(row=>{row.children[1].innerHTML='<span class="text-increase">$0</span><span class="text-textTertiary"><span>0</span></span>';});
      };
      modal.querySelector('#positions').onscroll=()=>{log('History scroll');render();};
      modal.querySelector('#opened').onclick=function(){
        this.textContent=this.textContent.includes('↓')?'Opened ↑':'Opened ↓';log(this.textContent);render();
        if(cfg.holdSecondHistory&&w===1){
          const positions=modal.querySelector('#positions');positions.setAttribute('aria-busy','true');
          const release=document.createElement('button');release.textContent='Finish loading History';positions.append(release);
          release.onclick=()=>{positions.removeAttribute('aria-busy');render();log('History ready');};
        }
        if(cfg.slowHistoryMs){
          const positions=modal.querySelector('#positions');positions.setAttribute('aria-busy','true');
          const stale=positions.querySelector('.position');stale.querySelector('a').href=cfg.tokens[8].url;stale.querySelector('.text-textPrimary').textContent='T9';positions.innerHTML=stale.outerHTML;
          setTimeout(()=>{if(!modal.isConnected)return;positions.removeAttribute('aria-busy');render();log('History ready');},cfg.slowHistoryMs);
        }
      };render();
      if(cfg.transientEmptyMs){
        const positions=modal.querySelector('#positions');positions.setAttribute('aria-busy','true');positions.innerHTML='<span>No historic positions</span>';
        setTimeout(()=>{if(!modal.isConnected)return;positions.removeAttribute('aria-busy');render();log('History ready');},cfg.transientEmptyMs);
      }
    };
  }
  document.querySelector('#search').onclick=()=>{
    log('Search'); const search=document.createElement('div'); search.id='search-modal';
    search.style.cssText='position:fixed;left:12px;top:100px;width:700px;padding:16px;background:#151823;z-index:150';
    search.innerHTML='<button id="wallet-filter" aria-pressed="false">Wallets</button><div><input placeholder="Search by name, ticker, CA, or wallet"><button id="search-close">Esc</button></div><div id="search-results"></div>';
    document.body.append(search);
    search.querySelector('#search-close').onclick=()=>search.remove();
    search.querySelector('#wallet-filter').onclick=function(){this.setAttribute('aria-pressed','true');log('Wallets');};
    const input=search.querySelector('input'), results=search.querySelector('#search-results');
    input.oninput=()=>{
      const query=input.value; log('Search input:'+query); results.innerHTML='Loading';results.setAttribute('aria-busy','true');
      setTimeout(()=>{
        if(!search.isConnected||input.value!==query)return;results.removeAttribute('aria-busy');results.innerHTML='';
        const w=cfg.wallets.indexOf(query);
        if(w<0||cfg.searchMode==='missing'){results.textContent='No wallets found';return;}
        const wallet=cfg.wallets[w], row=document.createElement('div');row.className='cursor-pointer';
        row.innerHTML='<button type="button" aria-label="View wallet '+wallet.slice(0,4)+'...'+wallet.slice(-4)+'"></button><div><span><button aria-label="Copy address"><span>'+wallet.slice(0,4)+'...'+wallet.slice(-4)+'</span><i class="ri-file-copy-line"></i></button></span></div><span>PnL $100 Win 50%</span>';
        row.querySelector('button[aria-label="Copy address"]').onclick=e=>{
          e.stopPropagation();
          const value=cfg.searchMode==='wrong-result'?wallet.slice(0,10)+(wallet[10]==='a'?'b':'a')+wallet.slice(11):wallet;
          navigator.clipboard.writeText(value);
        };
        row.querySelector('button[aria-label^="View wallet"]').onclick=()=>{
          log('Search result:'+w);search.remove();openWallet(cfg.searchMode==='wrong-modal'?(w+1)%3:w);
          if(cfg.searchMode==='wrong-chain')document.querySelector('#modal button[aria-label^="Open in"]').setAttribute('aria-label',cfg.chain==='bnb'?'Open in RH Scan':'Open in BSCScan');
        };
        results.append(row);
      }, cfg.searchDelayMs??150);
    };
  };
  renderTrades();
  </script></body></html>`;
}
