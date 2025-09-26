define(['qlik'],function(qlik){
  return{
    type:'items',
    component:'accordion',
    items:{
      settings:{
        uses:'settings',
        items:{
          title:{type:'string',ref:'props.title',label:'Title',defaultValue:'Qlik Trail'},
          autoRecord:{type:'boolean',ref:'props.autoRecord',label:'Auto-record on selection change',defaultValue:false},
          autoStates:{type:'boolean',ref:'props.autoStates',label:'Auto-detect states from current selections',defaultValue:true},
          statesCsv:{type:'string',ref:'props.statesCsv',label:'States to track (comma separated)',defaultValue:'$'},
          persistKey:{type:'string',ref:'props.persistKey',label:'Storage key (optional)',defaultValue:''},
          replayDelayMs:{type:'number',ref:'props.replayDelayMs',label:'Replay step delay (ms)',defaultValue:400},
          replayQuietMs:{type:'number',ref:'props.replayQuietMs',label:'Auto-record quiet window after replay (ms)',defaultValue:1200}
        }
      }
    }
  };
});
