
define(['qlik','jquery','./properties','text!./style.css'], function(qlik, $, props, css){
  'use strict';
  var app = qlik.currApp();
  if(!document.getElementById('tmS-style')){ var st=document.createElement('style'); st.id='tmS-style'; st.textContent=css; document.head.appendChild(st); }

  function uid(){ return 's_' + Math.random().toString(36).slice(2,8); }
  function saveLocal(k,o){ try{ localStorage.setItem(k, JSON.stringify(o)); }catch(e){} }
  function loadLocal(k,f){ try{ var x=localStorage.getItem(k); return x?JSON.parse(x):f; }catch(e){ return f; } }

  function getSelectedFieldNames(){
    return new Promise(function(resolve){
      app.getList('SelectionObject', function(m){
        try{
          var items=(m.qSelectionObject && m.qSelectionObject.qSelections) ? m.qSelectionObject.qSelections : [];
          var names=[];
          for (var i=0;i<items.length;i++){
            var it=items[i]; var st=it.qStateName || '$';
            if (st==='$'){ if(names.indexOf(it.qField)===-1) names.push(it.qField); }
          }
          console.log('[TrailMixSimple] Fields in $:', names);
          resolve(names);
        }catch(e){ console.warn('[TrailMixSimple] getList error', e); resolve([]); }
      }, { qStateName:'$' });
    });
  }

  function fetchValues(fieldName){
    console.log('[TrailMixSimple] Fetch values for', fieldName);
    return app.createList({
      qStateName:'$',
      qDef:{ qFieldDefs:[fieldName] },
      qInitialDataFetch:[{ qTop:0, qLeft:0, qWidth:1, qHeight:10000 }]
    }).then(function(obj){
      return obj.getLayout().then(function(l){
        var rows=(l.qListObject && l.qListObject.qDataPages && l.qListObject.qDataPages[0] && l.qListObject.qDataPages[0].qMatrix) || [];
        var pack={ text:[], num:[] };
        for (var i=0;i<rows.length;i++){
          var c=rows[i][0]; var st=c.qState;
          if (st==='S' || st==='L' || st==='XS'){
            pack.text.push(String(c.qText));
            if (typeof c.qNum==='number' && !isNaN(c.qNum)) pack.num.push(c.qNum);
          }
        }
        try{ obj.close(); }catch(e){}
        console.log('[TrailMixSimple] Captured', fieldName, pack);
        return pack;
      });
    })['catch'](function(err){ console.warn('[TrailMixSimple] fetchValues failed for', fieldName, err); return {text:[], num:[]}; });
  }

  function captureSnapshot(){
    return getSelectedFieldNames().then(function(fields){
      var res={}; var seq=Promise.resolve();
      for (var i=0;i<fields.length;i++){
        (function(fname){ seq=seq.then(function(){ return fetchValues(fname).then(function(pack){ res[fname]=pack; }); }); })(fields[i]);
      }
      return seq.then(function(){ var snap={ state:'$', fields:res }; console.log('[TrailMixSimple] Snapshot', snap); return snap; });
    });
  }

  function selectByField(fname, pack){
    var nums=(pack.num||[]), texts=(pack.text||[]);
    console.log('[TrailMixSimple] Replay field', fname, 'nums:', nums, 'texts:', texts);
    var f = app.field(fname, '$');
    if(nums.length){
      var arr = nums.map(function(n){ return { qNumber:n }; });
      return f.selectValues(arr, false, false).then(function(){ console.log('[TrailMixSimple] selectValues by number done for', fname); });
    }
    if(texts.length){
      var arr2 = texts.map(function(t){ return { qText:String(t) }; });
      return f.selectValues(arr2, false, false).then(function(){ console.log('[TrailMixSimple] selectValues by text done for', fname); });
    }
    console.log('[TrailMixSimple] Nothing to select for', fname);
    return qlik.Promise.resolve();
  }

  function selectByCalcDim(expr, pack){
    console.log('[TrailMixSimple] Replay calc dim', expr, pack);
    return app.createCube({
      qStateName:'$',
      qDimensions:[{ qDef:{ qDef: expr } }],
      qInitialDataFetch:[{ qTop:0, qLeft:0, qWidth:1, qHeight:10000 }]
    }).then(function(cube){
      return cube.getLayout().then(function(l){
        var rows=(l.qHyperCube && l.qHyperCube.qDataPages && l.qHyperCube.qDataPages[0] && l.qHyperCube.qDataPages[0].qMatrix) || [];
        var indices=[]; var i;
        if ((pack.num||[]).length){
          for(i=0;i<rows.length;i++){ var c=rows[i][0]; if (typeof c.qNum==='number' && pack.num.indexOf(c.qNum)!==-1) indices.push(i); }
        } else {
          for(i=0;i<rows.length;i++){ var c2=rows[i][0]; if (pack.text.indexOf(String(c2.qText))!==-1) indices.push(i); }
        }
        console.log('[TrailMixSimple] indices for calc dim', indices);
        return cube.selectHyperCubeValues('/qHyperCubeDef', 0, indices, false).then(function(){
          console.log('[TrailMixSimple] selectHyperCubeValues done');
          try{ cube.close(); }catch(e){}
        });
      });
    });
  }

  function applySnapshot(snap){
    console.log('[TrailMixSimple] Apply snapshot', snap);
    return app.clearAll(false,'$').then(function(){
      var flds = snap.fields || {};
      var names = Object.keys(flds);
      var seq = Promise.resolve();
      names.forEach(function(fname){
        (function(name, pack){
          seq = seq.then(function(){
            if (name && name.charAt && name.charAt(0)==='='){ return selectByCalcDim(name, pack); }
            else { return selectByField(name, pack); }
          }).then(function(){
            // log selections after each field
            return getSelectedFieldNames().then(function(n){ console.log('[TrailMixSimple] Fields after selecting', name, ':', n); });
          });
        })(fname, flds[fname]||{text:[],num:[]});
      });
      return seq.then(function(){ console.log('[TrailMixSimple] Replay complete'); });
    });
  }

  function itemDiv(step,activeId){
    var d=document.createElement('div'); d.className='tmS-item' + (step.id===activeId ? ' active' : ''); d.textContent=step.name || step.id; d.dataset.id=step.id; return d;
  }

  return {
    definition: props,
    paint: function($el,layout){
      var key='trailmix-simple:'+qlik.currApp().id;
      if(!$el[0].init){
        $el.empty();
        var root=document.createElement('div'); root.className='tmS-root'; $el[0].appendChild(root);
        var tb=document.createElement('div'); tb.className='tmS-toolbar'; root.appendChild(tb);
        tb.innerHTML='<button class=\"tmS-btn\" data-act=\"record\">Record</button>';
        var body=document.createElement('div'); body.className='tmS-body'; root.appendChild(body);
        var list=document.createElement('div'); list.className='tmS-list'; body.appendChild(list);
        var detail=document.createElement('div'); detail.className='tmS-detail'; body.appendChild(detail);
        $el[0].ctx={root:root,tb:tb,list:list,detail:detail,activeId:null}; $el[0].init=true;
      }
      var ctx=$el[0].ctx;
      var steps = loadLocal(key, []);

      function renderList(){
        ctx.list.innerHTML='<div style=\"font-weight:600;margin-bottom:6px\">Steps</div>';
        for (var i=0;i<steps.length;i++){
          var it=itemDiv(steps[i], ctx.activeId);
          (function(step){ it.onclick=function(){ ctx.activeId=step.id; renderList(); renderDetail(); }; })(steps[i]);
          ctx.list.appendChild(it);
        }
      }
      function renderDetail(){
        var sel=null; for (var i=0;i<steps.length;i++){ if(steps[i].id===ctx.activeId){ sel=steps[i]; break; } }
        ctx.detail.innerHTML=''; if(!sel) return;
        var h=document.createElement('div'); h.innerHTML='<div><span class=\"tmS-badge\">$</span> <strong>'+ (sel.name||sel.id) +'</strong></div>'; ctx.detail.appendChild(h);
        var snap=sel.snapshot;
        if(!snap || !snap.fields || !Object.keys(snap.fields).length){ var p=document.createElement('div'); p.textContent='No fields selected.'; ctx.detail.appendChild(p); }
        else{
          Object.keys(snap.fields).forEach(function(fname){
            var pack=snap.fields[fname]||{text:[],num:[]};
            var row=document.createElement('div'); row.className='tmS-field';
            var title=document.createElement('div'); title.style.fontWeight='600'; title.textContent=fname+':'; row.appendChild(title);
            (pack.text||[]).slice(0,50).forEach(function(v){ var chip=document.createElement('span'); chip.className='tmS-chip'; chip.textContent=v; row.appendChild(chip); });
            if ((pack.num||[]).length && !(pack.text||[]).length){ var chip=document.createElement('span'); chip.className='tmS-chip'; chip.textContent='[numeric '+pack.num.length+' values]'; row.appendChild(chip); }
            ctx.detail.appendChild(row);
          });
        }
        var btn=document.createElement('button'); btn.className='tmS-btn'; btn.textContent='Replay to here';
        btn.onclick=function(){ btn.disabled=true; applySnapshot(sel.snapshot).then(function(){ btn.disabled=false; }); };
        ctx.detail.appendChild(btn);
      }

      renderList(); renderDetail();

      if(!ctx.wired){
        ctx.wired=true;
        ctx.tb.querySelector('[data-act=\"record\"]').onclick=function(){
          captureSnapshot().then(function(snap){
            var step={ id:uid(), name:'', snapshot:snap };
            steps.push(step); saveLocal(key, steps); ctx.activeId=step.id; renderList(); renderDetail();
          });
        };
      }
      return qlik.Promise.resolve();
    }
  };
});
