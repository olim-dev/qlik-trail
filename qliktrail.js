define(['qlik','jquery','./properties','text!./style.css'], function(qlik, $, props, css){
  'use strict';

  // inject CSS once
  if (!document.getElementById('qliktrail-style')) {
    var st = document.createElement('style');
    st.id = 'qliktrail-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  var app = qlik.currApp();

  // utils
  function uid(){ return 'p_' + Math.random().toString(36).slice(2,8); }
  function now(){ return new Date().toISOString(); }
  function saveLocal(k,o){ try{ localStorage.setItem(k, JSON.stringify(o)); }catch(e){} }
  function loadLocal(k,f){ try{ var x=localStorage.getItem(k); return x?JSON.parse(x):f; }catch(e){ return f; } }
  function deepClone(o){ return JSON.parse(JSON.stringify(o)); }

  // trail helpers
  function defTrail(appId,title){ return { version:1, appId:appId, title:title||'Qlik Trail', nodes:[], groups:{} }; }
  function findNode(tr,id){ var found=null; (function walk(ns){ (ns||[]).forEach(function(n){ if(n.id===id){found=n;return;} if(!found && n.children) walk(n.children); }); })(tr.nodes); return found; }
  function allNodes(tr){ var out=[]; (function walk(ns){ (ns||[]).forEach(function(n){ out.push(n); if(n.children) walk(n.children); }); })(tr.nodes); return out; }
  function addChild(tr,parentId,node){
    if(!parentId){ tr.nodes.push(node); return; }
    var stack=(tr.nodes||[]).slice();
    while(stack.length){
      var p=stack.shift();
      if(p.id===parentId){
        p.children=p.children||[];
        p.children.push(node);
        return;
      }
      if(p.children) Array.prototype.push.apply(stack,p.children);
    }
    tr.nodes.push(node);
  }
  function removeNode(tr,id){
    function walk(nodes){
      for(var i=0;i<nodes.length;i++){
        if(nodes[i].id===id){ nodes.splice(i,1); return true; }
        if(nodes[i].children && walk(nodes[i].children)) return true;
      }
      return false;
    }
    return walk(tr.nodes);
  }
  function maxSeq(tr){ var m=0; allNodes(tr).forEach(function(n){ if((n.seq||0)>m) m=n.seq; }); return m; }
  function assignSeqIfMissing(tr){ var i=1; allNodes(tr).forEach(function(n){ if(typeof n.seq!=='number'){ n.seq=i; i++; } }); }
  function flatBySeq(tr){ return allNodes(tr).slice().sort(function(a,b){ return (a.seq||0)-(b.seq||0); }); }
  function ungroupedIds(tr){
    var ids=allNodes(tr).map(function(n){return n.id;});
    var inGroup={};
    Object.keys(tr.groups||{}).forEach(function(g){
      (tr.groups[g].members||[]).forEach(function(id){ inGroup[id]=true; });
    });
    return ids.filter(function(id){ return !inGroup[id]; });
  }
  function membersBySeq(tr, ids){
    var map={}; allNodes(tr).forEach(function(n){ map[n.id]=n; });
    return ids.map(function(id){ return map[id]; }).filter(Boolean)
             .sort(function(a,b){ return (a.seq||0)-(b.seq||0); });
  }

  // NEW: find which group a step belongs to
  function stepGroupOf(tr, stepId){
    var found = null;
    Object.keys(tr.groups||{}).some(function(gid){
      var mem = tr.groups[gid].members || [];
      if (mem.indexOf(stepId) !== -1){ found = gid; return true; }
      return false;
    });
    return found; // null => ungrouped
  }
  // NEW: move a step to a group (or ungrouped when gid===null or '__ungrouped')
  function moveStepToGroup(tr, stepId, gid){
    // remove from all groups first
    Object.keys(tr.groups||{}).forEach(function(g){
      var mem = tr.groups[g].members || [];
      tr.groups[g].members = mem.filter(function(id){ return id !== stepId; });
    });
    if (gid && gid !== '__ungrouped'){
      tr.groups[gid] = tr.groups[gid] || { id:gid, name:gid, members:[] };
      if (tr.groups[gid].members.indexOf(stepId) === -1){
        tr.groups[gid].members.push(stepId);
      }
    }
  }

  // selection capture / replay
  function getSelectionsGroupedByState(){
    return new Promise(function(resolve){
      app.getList('SelectionObject', function(m){
        try{
          var items=(m.qSelectionObject&&m.qSelectionObject.qSelections)||[];
          var grouped={};
          items.forEach(function(it){
            var st=it.qStateName||'$';
            grouped[st]=grouped[st]||[];
            if(grouped[st].indexOf(it.qField)===-1) grouped[st].push(it.qField);
          });
          resolve(grouped);
        }catch(e){ resolve({}); }
      });
    });
  }
  function fetchValues(fieldName, stateName){
    return app.createList({
      qStateName:stateName||'$',
      qDef:{ qFieldDefs:[fieldName] },
      qInitialDataFetch:[{ qTop:0,qLeft:0,qWidth:1,qHeight:10000 }]
    }).then(function(obj){
      return obj.getLayout().then(function(l){
        var rows=(l.qListObject&&l.qListObject.qDataPages&&l.qListObject.qDataPages[0]&&l.qListObject.qDataPages[0].qMatrix)||[];
        var pack={text:[],num:[]};
        for(var i=0;i<rows.length;i++){
          var c=rows[i][0];
          if(c.qState==='S'||c.qState==='L'||c.qState==='XS'){
            pack.text.push(String(c.qText));
            if(typeof c.qNum==='number' && !isNaN(c.qNum)) pack.num.push(c.qNum);
          }
        }
        try{ obj.close(); }catch(e){}
        return pack;
      });
    })['catch'](function(){ return {text:[],num:[]}; });
  }
  function captureSnapshot(){
    return getSelectionsGroupedByState().then(function(grouped){
      var payload=[]; var seq=Promise.resolve();
      Object.keys(grouped).forEach(function(stateName){
        seq = seq.then(function(){
          var fields=grouped[stateName]||[]; var fmap={}; var inner=Promise.resolve();
          fields.forEach(function(fname){
            inner = inner.then(function(){ return fetchValues(fname,stateName).then(function(pack){ fmap[fname]=pack; }); });
          });
          return inner.then(function(){ payload.push({state:stateName,fields:fmap}); });
        });
      });
      return seq.then(function(){ return {ts:now(), states:payload}; });
    });
  }
  function applySnapshot(snap){
    var p=Promise.resolve();
    (snap.states||[]).forEach(function(st){
      p = p.then(function(){ return app.clearAll(false, st.state); })
           .then(function(){
             var inner=Promise.resolve();
             Object.keys(st.fields||{}).forEach(function(fname){
               var f=app.field(fname, st.state||'$');
               var pack=st.fields[fname]||{text:[],num:[]};
               inner = inner.then(function(){
                 if((pack.num||[]).length){
                   return f.selectValues(pack.num.map(function(n){return{qNumber:n};}), false,false);
                 }
                 if((pack.text||[]).length){
                   return f.selectValues(pack.text.map(function(t){return{qText:String(t)};}), false,false);
                 }
                 return qlik.Promise.resolve();
               });
             });
             return inner;
           });
    });
    return p;
  }

  // signature helper for auto-record
  function signatureFromSelObj(selObj){
    try{
      var arr=(selObj.qSelectionObject&&selObj.qSelectionObject.qSelections)||[];
      return JSON.stringify(arr.map(function(a){
        var cnt=a.qSelectedCount||0;
        return a.qField+':'+(a.qStateName||'$')+':'+cnt;
      }));
    }catch(e){ return ''; }
  }

  return {
    definition: props,
    paint: function($el, layout){
      var appId = app.id;
      var key = 'qliktrail-pro:'+appId;

      if(!$el[0].init){
        $el.empty();
        var root = $('<div class="tmp-root">');
        var tb = $([
          '<div class="tmp-toolbar">',
            '<button class="tmp-btn tmp-accent" data-a="rec">Record</button>',
            '<button class="tmp-btn" data-a="replayStart" disabled>Replay from start</button>',
            '<button class="tmp-btn tmp-danger" data-a="del" disabled>Delete</button>',
            '<button class="tmp-btn tmp-danger" data-a="delAll">Delete all</button>',
            '<div style="margin-left:auto;display:flex;gap:8px;align-items:center">',
              '<label class="tmp-check"><input type="checkbox" data-a="auto"/> Auto</label>',
              '<select class="tmp-select" data-a="group"><option value="">All groups</option><option value="__ungrouped">Ungrouped</option></select>',
              '<button class="tmp-btn" data-a="newGroup">New group</button>',
              '<button class="tmp-btn" data-a="export">Export</button>',
              '<input type="file" data-a="importFile" accept=".json" style="display:none"/>',
              '<button class="tmp-btn" data-a="import">Import</button>',
            '</div>',
          '</div>'
        ].join(''));

        var body = $('<div class="tmp-body">');
        var left = $('<div class="tmp-tree"></div>');
        var right = $('<div class="tmp-detail"></div>');
        body.append(left,right);
        root.append(tb, body);
        $el.append(root);
        $el[0].init = { tb:tb, left:left, right:right, active:null, filter:'', autoOn:false, lastSig:'', replayQuietUntil:0 };
      }

      var ui = $el[0].init;

      var trail = loadLocal(key,null);
      if(!trail || trail.appId!==appId){ trail=defTrail(appId,'Qlik Trail'); saveLocal(key,trail); }
      assignSeqIfMissing(trail);

      function renderFilter(){
        var sel=ui.tb.find('[data-a="group"]');
        var current=sel.val();
        sel.empty().append('<option value="">All groups</option><option value="__ungrouped">Ungrouped</option>');
        Object.keys(trail.groups||{}).forEach(function(gid){
          sel.append('<option value="'+gid+'">'+(trail.groups[gid].name||gid)+'</option>');
        });
        if(current && (current==='__ungrouped' || trail.groups[current])) sel.val(current); else sel.val('');
        ui.filter = sel.val();
        sel.off('change').on('change', function(){ ui.filter=$(this).val(); renderLeft(); renderRight(); });
      }

      function renderLeft(){
        ui.left.empty();

        // UNGROUPED
        if(ui.filter==='' || ui.filter==='__ungrouped'){
          var openUng = (ui.filter==='__ungrouped');
          var hd = $('<div class="tmp-sec-hd"><div class="tmp-sec-title">'+(openUng?'▾':'▸')+' Ungrouped <span class="tmp-small">('+(ungroupedIds(trail).length)+')</span></div></div>');
          ui.left.append(hd);
          hd.on('click', function(){ var sel=ui.tb.find('[data-a="group"]'); sel.val(openUng?'':'__ungrouped').trigger('change'); });
          if(openUng){
            var list=$('<div class="tmp-list"></div>');
            membersBySeq(trail, ungroupedIds(trail)).forEach(function(n){
              var row=$('<div class="tmp-node" data-id="'+n.id+'"><span>'+(n.name||n.id)+'</span><div class="tmp-row-actions"><button class="tmp-copy">⧉</button><button class="tmp-trash">🗑</button></div></div>');
              row.toggleClass('active', ui.active===n.id);
              row.on('click', function(){ ui.active=n.id; renderLeft(); renderRight(); });
              row.find('.tmp-copy').on('click', function(ev){ ev.stopPropagation(); var dup=deepClone(n); dup.id=uid(); dup.seq=maxSeq(trail)+1; addChild(trail,null,dup); saveLocal(key,trail); renderLeft(); });
              row.find('.tmp-trash').on('click', function(ev){ ev.stopPropagation(); removeNode(trail,n.id); Object.keys(trail.groups||{}).forEach(function(g){ var m=trail.groups[g].members||[]; trail.groups[g].members=m.filter(function(x){return x!==n.id;}); }); saveLocal(key,trail); if(ui.active===n.id) ui.active=null; renderLeft(); renderRight(); });
              list.append(row);
            });
            ui.left.append(list);
          }
        }

        // GROUPS
        Object.keys(trail.groups||{}).forEach(function(gid){
          if(ui.filter && ui.filter!==gid) return;
          var g=trail.groups[gid]; var open=(ui.filter===gid);
          var hd = $('<div class="tmp-sec-hd"><div class="tmp-sec-title">'+(open?'▾':'▸')+' '+(g.name||gid)+' <span class="tmp-small">('+(g.members||[]).length+')</span></div><div class="tmp-sec-actions"><button class="tmp-icon" data-a="ren">✎</button><button class="tmp-icon" data-a="del">🗑</button></div></div>');
          ui.left.append(hd);
          hd.find('[data-a="ren"]').on('click', function(ev){ ev.stopPropagation(); var name=prompt('Rename group', g.name||gid); if(name){ g.name=name; saveLocal(key,trail); renderFilter(); renderLeft(); } });
          hd.find('[data-a="del"]').on('click', function(ev){ ev.stopPropagation(); if(confirm('Delete group?')){ delete trail.groups[gid]; saveLocal(key,trail); renderFilter(); renderLeft(); } });
          hd.on('click', function(){ ui.tb.find('[data-a="group"]').val(open?'':gid).trigger('change'); });

          if(open){
            var list=$('<div class="tmp-list"></div>');
            membersBySeq(trail, g.members||[]).forEach(function(n){
              var row=$('<div class="tmp-node" data-id="'+n.id+'"><span>'+(n.name||n.id)+'</span><div class="tmp-row-actions"><button class="tmp-ungroup">Ungroup</button><button class="tmp-copy">⧉</button><button class="tmp-trash">🗑</button></div></div>');
              row.toggleClass('active', ui.active===n.id);
              row.on('click', function(){ ui.active=n.id; renderLeft(); renderRight(); });
              row.find('.tmp-ungroup').on('click', function(ev){ ev.stopPropagation(); g.members=(g.members||[]).filter(function(x){return x!==n.id;}); saveLocal(key,trail); renderLeft(); });
              row.find('.tmp-copy').on('click', function(ev){ ev.stopPropagation(); var dup=deepClone(n); dup.id=uid(); dup.seq=maxSeq(trail)+1; addChild(trail,null,dup); g.members.push(dup.id); saveLocal(key,trail); renderLeft(); });
              row.find('.tmp-trash').on('click', function(ev){ ev.stopPropagation(); removeNode(trail,n.id); Object.keys(trail.groups||{}).forEach(function(g2){ var m=trail.groups[g2].members||[]; trail.groups[g2].members=m.filter(function(x){return x!==n.id;}); }); saveLocal(key,trail); if(ui.active===n.id) ui.active=null; renderLeft(); renderRight(); });
              list.append(row);
            });
            ui.left.append(list);
          }
        });

        ui.tb.find('[data-a="replayStart"]').prop('disabled', allNodes(trail).length===0);
        ui.tb.find('[data-a="del"]').prop('disabled', !ui.active);
      }

      function renderRight(){
        ui.right.empty();
        var n=findNode(trail, ui.active);
        if(!n){ ui.tb.find('[data-a="del"]').prop('disabled', true); return; }
        ui.tb.find('[data-a="del"]').prop('disabled', false);

        // header + name
        ui.right.append(
          '<div><span class="tmp-badge">main</span> '+
          '<input class="tmp-input" data-a="name" placeholder="Step name" value="'+(n.name||'')+'"/></div>'
        );

        // NEW: group picker for this step
        var currentG = stepGroupOf(trail, n.id) || '__ungrouped';
        var gp = $('<div class="tmp-section"></div>');
        var selHtml = '<label class="tmp-small" style="display:block;margin:8px 0 4px">Group</label>'+
                      '<select class="tmp-select" data-a="stepGroup" style="min-width:220px">'+
                      '<option value="__ungrouped">Ungrouped</option>';
        Object.keys(trail.groups||{}).forEach(function(gid){
          var name = trail.groups[gid].name || gid;
          selHtml += '<option value="'+gid+'">'+name+'</option>';
        });
        selHtml += '</select>';
        gp.append(selHtml);
        ui.right.append(gp);
        ui.right.find('[data-a="stepGroup"]').val(currentG);
        ui.right.find('[data-a="stepGroup"]').on('change', function(){
          var gid = this.value;
          moveStepToGroup(trail, n.id, gid);
          saveLocal(key, trail);
          // Keep current filter if possible; refresh left to update counts/membership.
          renderLeft();
        });

        // snapshot view
        var snap=n.snapshot||{states:[]};
        var box=$('<div class="tmp-step"><b>Snapshot</b></div>');
        (snap.states||[]).forEach(function(st){
          var s=$('<div style="margin:8px 0"><b>State '+st.state+'</b><div></div></div>');
          Object.keys(st.fields||{}).forEach(function(fname){
            var pack=st.fields[fname]||{text:[],num:[]};
            var row=$('<div class="tmp-field"><span style="font-weight:600">'+fname+':</span></div>');
            (pack.text||[]).slice(0,50).forEach(function(v){ row.append('<span class="tmp-chip">'+v+'</span>'); });
            if((pack.num||[]).length && !(pack.text||[]).length){ row.append('<span class="tmp-chip">[numeric '+pack.num.length+' values]</span>'); }
            s.append(row);
          });
          box.append(s);
        });
        ui.right.append(box);

        // actions
        var act=$('<div class="tmp-footer"><button class="tmp-btn" data-a="replay">Replay to here</button></div>');
        ui.right.append(act);
        ui.right.find('[data-a="name"]').on('change', function(){ n.name=this.value; saveLocal(key,trail); renderLeft(); });
        act.find('[data-a="replay"]').on('click', function(){
          if(!n.snapshot) return;
          ui.replayQuietUntil = Date.now() + (layout.props.replayQuietMs||1200); // quiet auto during single-step replay
          applySnapshot(n.snapshot);
        });
      }

      // actions
      function record(){
        return captureSnapshot().then(function(snap){
          var node={ id:uid(), name:'', createdAt:now(), branch:'main', snapshot:snap, children:[], seq:maxSeq(trail)+1 };
          addChild(trail,null,node);
          ui.active=node.id;
          saveLocal(key,trail);
          renderFilter(); renderLeft(); renderRight();
        });
      }

      // one-time wiring
      if(!ui.wired){
        ui.wired=true;

        ui.tb.on('click','[data-a="rec"]', record);

        ui.tb.on('click','[data-a="replayStart"]', function(){
          var seq=[];
          if(ui.filter==='__ungrouped') seq = membersBySeq(trail, ungroupedIds(trail));
          else if(ui.filter)           seq = membersBySeq(trail, (trail.groups[ui.filter]||{members:[]}).members);
          else                         seq = flatBySeq(trail);

          // quiet the auto-recorder while replaying the chain
          var totalQuiet = (layout.props.replayQuietMs||1200) * (seq.length+1);
          ui.replayQuietUntil = Date.now() + totalQuiet;

          var p=Promise.resolve();
          seq.forEach(function(step){ p=p.then(function(){ return applySnapshot(step.snapshot||{states:[]}); }); });
        });

        ui.tb.on('click','[data-a="del"]', function(){
          var n=findNode(trail, ui.active); if(!n) return;
          removeNode(trail,n.id);
          Object.keys(trail.groups||{}).forEach(function(g){ var m=trail.groups[g].members||[]; trail.groups[g].members=m.filter(function(x){return x!==n.id;}); });
          ui.active=null; saveLocal(key,trail); renderLeft(); renderRight();
        });

        ui.tb.on('click','[data-a="delAll"]', function(){
          if(!confirm('Delete all steps?')) return;
          trail.nodes=[]; ui.active=null; saveLocal(key,trail); renderLeft(); renderRight();
        });

        // group create
        ui.tb.on('click','[data-a="newGroup"]', function(){
          var name=prompt('Group name','New group'); if(!name) return;
          var gid='g_'+Math.random().toString(36).slice(2,7);
          trail.groups[gid]={ id:gid, name:name, members:[] };
          saveLocal(key,trail); renderFilter(); renderLeft(); renderRight();
        });

        // export / import
        ui.tb.on('click','[data-a="export"]', function(){
          var blob=new Blob([JSON.stringify(trail,null,2)],{type:'application/json'});
          var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='qliktrail_export_'+(new Date().toISOString().slice(0,19).replace(/[:T]/g,'-'))+'.json';
          document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },0);
        });
        ui.tb.on('click','[data-a="import"]', function(){ ui.tb.find('[data-a="importFile"]').val('').trigger('click'); });
        ui.tb.on('change','[data-a="importFile"]', function(ev){
          var file=ev.target.files && ev.target.files[0]; if(!file) return;
          var reader=new FileReader();
          reader.onload=function(){
            try{
              var imported=JSON.parse(reader.result||'{}');
              if(imported && imported.nodes){
                trail = imported;
                if(!trail.groups) trail.groups={};
                Object.keys(trail.groups).forEach(function(g){
                  trail.groups[g].members=(trail.groups[g].members||[]).filter(function(id){ return !!findNode(trail,id); });
                });
                saveLocal(key,trail);
                ui.active=null; renderFilter(); renderLeft(); renderRight();
              }else{ alert('Invalid file.'); }
            }catch(e){ alert('Could not import JSON.'); }
          };
          reader.readAsText(file);
        });

        // auto-record wiring
        ui.tb.find('[data-a="auto"]').prop('checked', !!layout.props.autoRecord);
        ui.autoOn = !!layout.props.autoRecord;

        ui.tb.on('change','[data-a="auto"]', function(){
          ui.autoOn = this.checked;
        });

        // selection listener: compute signature; if changed & allowed -> record
        app.getList('SelectionObject', function(m){
          var sig = signatureFromSelObj(m);
          if(sig === ui.lastSig) return;          // no change
          ui.lastSig = sig;

          if(Date.now() < ui.replayQuietUntil) return;  // quiet window after replays

          var arr=(m.qSelectionObject&&m.qSelectionObject.qSelections)||[];
          if(!ui.autoOn || arr.length===0) return;

          record();
        });
      }

      renderFilter(); renderLeft(); renderRight();
      return qlik.Promise.resolve();
    }
  };
});
