/* laminar.js
 * frontend application for Laminar Continuous Integration
 * https://laminar.ohwg.net
 */

Vue.filter('iecFileSize', function(bytes) {
  var exp = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, exp)).toFixed(1) + ' ' +
    ['B', 'KiB', 'MiB', 'GiB', 'TiB'][exp];
});

const wsp = function(path) {
  return new WebSocket((location.protocol === 'https:'?'wss://':'ws://')
                          + location.host + path);
}
const WebsocketHandler = function() {
  function setupWebsocket(path, next) {
    var ws = wsp(path);
    ws.onmessage = function(msg) {
      msg = JSON.parse(msg.data);
      // "status" is the first message the websocket always delivers.
      // Use this to confirm the navigation. The component is not
      // created until next() is called, so creating a reference
      // for other message types must be deferred. There are some extra
      // subtle checks here. If this websocket already has a component,
      // then this is not the first time the status message has been
      // received. If the frontend requests an update, the status message
      // should not be handled here, but treated the same as any other
      // message. An exception is if the connection has been lost - in
      // that case we should treat this as a "first-time" status message.
      // this.comp.ws is used as a proxy for this.
      if (msg.type === 'status' && (!this.comp || !this.comp.ws)) {
        next(comp => {
          // Set up bidirectional reference
          // 1. needed to reference the component for other msg types
          this.comp = comp;
          // 2. needed to close the ws on navigation away
          comp.ws = this;
          // Update html and nav titles
          document.title = comp.$root.title = msg.title;
          // Calculate clock offset (used by ProgressUpdater)
          comp.$root.clockSkew = msg.time - Math.floor((new Date()).getTime()/1000);
          comp.$root.connected = true;
          // Component-specific callback handler
          comp[msg.type](msg.data);
        });
      } else {
        // at this point, the component must be defined
        if (!this.comp)
          return console.error("Page component was undefined");
        else {
          this.comp.$root.showNotify(msg.type, msg.data);
          if(typeof this.comp[msg.type] === 'function')
            this.comp[msg.type](msg.data);
        }
      }
    };
    ws.onclose = function(ev) {
      // if this.comp isn't set, this connection has never been used
      // and a re-connection isn't meaningful
      if(!ev.wasClean && 'comp' in this) {
        this.comp.$root.connected = false;
        // remove the reference to the websocket from the component.
        // This not only cleans up an unneeded reference but ensures a
        // status message on reconnection is treated as "first-time"
        delete this.comp.ws;
        this.reconnectTimeout = setTimeout(()=>{
          var newWs = setupWebsocket(path, (fn) => { fn(this.comp); });
          // the next() callback won't happen if the server is still
          // unreachable. Save the reference to the last component
          // here so we can recover if/when it does return. This means
          // passing this.comp in the next() callback above is redundant
          // but necessary to keep the same implementation.
          newWs.comp = this.comp;
        }, 2000);
      }
    }
    return ws;
  };
  return {
    beforeRouteEnter(to, from, next) {
      setupWebsocket(to.path, (fn) => { next(fn); });
    },
    beforeRouteUpdate(to, from, next) {
      this.ws.close();
      clearTimeout(this.ws.reconnectTimeout);
      setupWebsocket(to.path, (fn) => { fn(this); next(); });
    },
    beforeRouteLeave(to, from, next) {
      this.ws.close();
      clearTimeout(this.ws.reconnectTimeout);
      next();
    }
  };
}();

const Utils = {
  methods: {
    runIcon(result) {
      var marker = '⚙';
      var classname = result;
      if (result === 'success')
         marker = '✔';
      else if (result === 'failed' || result === 'aborted')
         marker = '✘';
      else
         classname = 'spin';
      return '<span title="' + result + '" class="status ' + classname + '">' + marker + '&#xfe0e;</span>';
    },
    formatDate: function(unix) {
      // TODO: reimplement when toLocaleDateString() accepts formatting options on most browsers
      var d = new Date(1000 * unix);
      var m = d.getMinutes();
      if (m < 10) m = '0' + m;
      return d.getHours() + ':' + m + ' on ' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' +
        d.getDate() + '. ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
        ][d.getMonth()] + ' ' +
        d.getFullYear();
    },
    formatDuration: function(start, end) {
      if(!end)
        end = Math.floor(Date.now()/1000) + this.$root.clockSkew;
      if(end - start > 3600)
        return Math.floor((end-start)/3600) + ' hours, ' + Math.floor(((end-start)%3600)/60) + ' minutes';
      else if(end - start > 60)
        return Math.floor((end-start)/60) + ' minutes, ' + ((end-start)%60) + ' seconds';
      else
        return (end-start) + ' seconds';
    }
  }
};

const ProgressUpdater = {
  data() { return { jobsRunning: [] }; },
  methods: {
    updateProgress(o) {
      if (o.etc) {
        var p = (Math.floor(Date.now()/1000) + this.$root.clockSkew - o.started) / (o.etc - o.started);
        if (p > 1.2) {
          o.overtime = true;
        } else if (p >= 1) {
          o.progress = 99;
        } else {
          o.progress = 100 * p;
        }
      }
    }
  },
  beforeDestroy() {
    clearInterval(this.updateTimer);
  },
  watch: {
    jobsRunning(val) {
      // this function handles several cases:
      // - the route has changed to a different run of the same job
      // - the current job has ended
      // - the current job has started (practically hard to reach)
      clearInterval(this.updateTimer);
      if (val.length) {
        // TODO: first, a non-animated progress update
        this.updateTimer = setInterval(() => {
          this.jobsRunning.forEach(this.updateProgress);
          this.$forceUpdate();
        }, 1000);
      }
    }
  }
};

const Home = function() {
  var state = {
    jobsQueued: [],
    jobsRecent: []
  };

  var chtUtilization, chtBuildsPerDay, chtBuildsPerJob, chtTimePerJob;

  var updateUtilization = function(busy) {
    chtUtilization.data.datasets[0].data[0] += busy ? 1 : -1;
    chtUtilization.data.datasets[0].data[1] -= busy ? 1 : -1;
    chtUtilization.update();
  }

  return {
    template: '#home',
    mixins: [WebsocketHandler, Utils, ProgressUpdater],
    data: function() {
      return state;
    },
    methods: {
      status: function(msg) {
        state.jobsQueued = msg.queued;
        state.jobsRunning = msg.running;
        state.jobsRecent = msg.recent;
        this.$forceUpdate();

        // setup charts
        chtUtilization = new Chart(document.getElementById("chartUtil"), {
          type: 'pie',
          data: {
            labels: ["Busy", "Idle"],
            datasets: [{
              data: [ msg.executorsBusy, msg.executorsTotal - msg.executorsBusy ],
              backgroundColor: ["tan", "darkseagreen"]
            }]
          }
        });
        chtBuildsPerDay = new Chart(document.getElementById("chartBpd"), {
          type: 'line',
          data: {
            labels: (()=>{
              res = [];
              var now = new Date();
              for (var i = 6; i >= 0; --i) {
                var then = new Date(now.getTime() - i * 86400000);
                res.push(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][then.getDay()]);
              }
              return res;
            })(),
            datasets: [{
              label: 'Successful Builds',
              backgroundColor: "rgba(143,188,143,0.65)", //darkseagreen at 0.65
              borderColor: "forestgreen",
              data: msg.buildsPerDay.map((e)=>{ return e.success || 0; })
            }, {
              label: 'Failed Builds',
              backgroundColor: "rgba(233,150,122,0.65)", //darkseagreen at 0.65
              borderColor: "crimson",
              data: msg.buildsPerDay.map((e)=>{ return e.failed || 0; })
            }]
          }
        });
        chtBuildsPerJob = new Chart(document.getElementById("chartBpj"), {
          type: 'horizontalBar',
          data: {
            labels: Object.keys(msg.buildsPerJob),
            datasets: [{
              label: 'Most runs per job in last 24hrs',
              backgroundColor: "lightsteelblue",
              data: Object.keys(msg.buildsPerJob).map((e)=>{ return msg.buildsPerJob[e]; })
            }]
          }
        });
        chtTimePerJob = new Chart(document.getElementById("chartTpj"), {
          type: 'horizontalBar',
          data: {
            labels: Object.keys(msg.timePerJob),
            datasets: [{
              label: 'Longest average runtime this week',
              backgroundColor: "lightsteelblue",
              data: Object.keys(msg.timePerJob).map((e)=>{ return msg.timePerJob[e]; })
            }]
          }
        });
      },
      job_queued: function(data) {
        state.jobsQueued.splice(0, 0, data);
        this.$forceUpdate();
      },
      job_started: function(data) {
        state.jobsQueued.splice(state.jobsQueued.length - data.queueIndex - 1, 1);
        state.jobsRunning.splice(0, 0, data);
        this.$forceUpdate();
        updateUtilization(true);
      },
      job_completed: function(data) {
        if (data.result === "success")
          chtBuildsPerDay.data.datasets[0].data[6]++;
        else
          chtBuildsPerDay.data.datasets[1].data[6]++;
        chtBuildsPerDay.update();

        for (var i = 0; i < state.jobsRunning.length; ++i) {
          var job = state.jobsRunning[i];
          if (job.name == data.name && job.number == data.number) {
            state.jobsRunning.splice(i, 1);
            state.jobsRecent.splice(0, 0, data);
            this.$forceUpdate();
            break;
          }
        }
        updateUtilization(false);
        for (var j = 0; j < chtBuildsPerJob.data.datasets[0].data.length; ++j) {
          if (chtBuildsPerJob.data.labels[j] == job.name) {
            chtBuildsPerJob.data.datasets[0].data[j]++;
            chtBuildsPerJob.update();
            break;
          }
        }
      }
    }
  };
}();

const Jobs = function() {
  var state = {
    jobs: [],
    search: '',
    tags: [],
    tag: null
  };
  return {
    template: '#jobs',
    mixins: [WebsocketHandler, Utils, ProgressUpdater],
    data: function() { return state; },
    methods: {
      status: function(msg) {
        state.jobs = msg.jobs;
        state.jobsRunning = msg.running;
        // mix running and completed jobs
        for (var i in msg.running) {
          var idx = state.jobs.findIndex(job => job.name === msg.running[i].name);
          if (idx > -1)
            state.jobs[idx] = msg.running[i];
          else {
            // special case: first run of a job.
            state.jobs.unshift(msg.running[i]);
            state.jobs.sort(function(a, b){return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;});
          }
        }
        var tags = {};
        for (var i in state.jobs) {
          for (var j in state.jobs[i].tags) {
            tags[state.jobs[i].tags[j]] = true;
          }
        }
        state.tags = Object.keys(tags);
      },
      job_started: function(data) {
        var updAt = null;
        // jobsRunning must be maintained for ProgressUpdater
        for (var i in state.jobsRunning) {
          if (state.jobsRunning[i].name === data.name) {
            updAt = i;
            break;
          }
        }
        if (updAt === null) {
          state.jobsRunning.unshift(data);
        } else {
          state.jobsRunning[updAt] = data;
        }
        updAt = null;
        for (var i in state.jobs) {
          if (state.jobs[i].name === data.name) {
            updAt = i;
            break;
          }
        }
        if (updAt === null) {
          // first execution of new job. TODO insert without resort
          state.jobs.unshift(data);
          state.jobs.sort(function(a, b){return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;});
        } else {
          state.jobs[updAt] = data;
        }
        this.$forceUpdate();
      },
      job_completed: function(data) {
        for (var i in state.jobs) {
          if (state.jobs[i].name === data.name) {
            state.jobs[i] = data;
            // forceUpdate in second loop
            break;
          }
        }
        for (var i in state.jobsRunning) {
          if (state.jobsRunning[i].name === data.name) {
            state.jobsRunning.splice(i, 1);
            this.$forceUpdate();
            break;
          }
        }
      },
      filteredJobs: function() {
        var ret = state.jobs;
        var tag = state.tag;
        if (tag) {
          ret = ret.filter(function(job) {
            return job.tags.indexOf(tag) >= 0;
          });
        }
        var search = this.search;
        if (search) {
          ret = ret.filter(function(job) {
            return job.name.indexOf(search) > -1;
          });
        }
        return ret;
      },
    }
  };
}();

var Job = function() {
  var state = {
    jobsRunning: [],
    jobsRecent: [],
    lastSuccess: null,
    lastFailed: null,
    nQueued: 0,
    pages: 0,
    sort: {}
  };
  return Vue.extend({
    template: '#job',
    mixins: [WebsocketHandler, Utils, ProgressUpdater],
    data: function() {
      return state;
    },
    methods: {
      status: function(msg) {
        state.jobsRunning = msg.running;
        state.jobsRecent = msg.recent;
        state.lastSuccess = msg.lastSuccess;
        state.lastFailed = msg.lastFailed;
        state.nQueued = msg.nQueued;
        state.pages = msg.pages;
        state.sort = msg.sort;

        var chtBt = new Chart(document.getElementById("chartBt"), {
          type: 'bar',
          data: {
            labels: msg.recent.map(function(e) {
              return '#' + e.number;
            }).reverse(),
            datasets: [{
              label: 'Build time',
              backgroundColor: (new Array(msg.recent.length)).fill('darkseagreen'),
              borderColor: (new Array(msg.recent.length)).fill('forestgreen'),
              data: msg.recent.map(function(e) {
                return e.completed - e.started;
              }).reverse()
            }]
          }
        });

        for (var i = 0, n = msg.recent.length; i < n; ++i) {
          if (msg.recent[i].result != "success") {
            chtBt.data.datasets[0].backgroundColor[n - i - 1] = "darksalmon";
            chtBt.data.datasets[0].borderColor[n - i - 1] = "crimson";
          }
        }
        chtBt.update();

      },
      job_queued: function() {
        state.nQueued++;
      },
      job_started: function(data) {
        state.nQueued--;
        state.jobsRunning.splice(0, 0, data);
        this.$forceUpdate();
      },
      job_completed: function(data) {
        for (var i = 0; i < state.jobsRunning.length; ++i) {
          var job = state.jobsRunning[i];
          if (job.number === data.number) {
            state.jobsRunning.splice(i, 1);
            state.jobsRecent.splice(0, 0, data);
            this.$forceUpdate();
            // TODO: update the chart
            break;
          }
        }
      },
      page_next: function() {
        state.sort.page++;
        this.ws.send(JSON.stringify(state.sort));
      },
      page_prev: function() {
        state.sort.page--;
        this.ws.send(JSON.stringify(state.sort));
      },
      do_sort: function(field) {
        if(state.sort.field == field) {
          state.sort.order = state.sort.order == 'asc' ? 'dsc' : 'asc';
        } else {
          state.sort.order = 'dsc';
          state.sort.field = field;
        }
        this.ws.send(JSON.stringify(state.sort));
      }
    }
  });
}();

const Run = function() {
  var state = {
    job: { artifacts: [] },
    latestNum: null,
    log: '',
    autoscroll: false
  };
  var firstLog = false;
  var logHandler = function(vm, d) {
    state.log += ansi_up.ansi_to_html(d.replace(/</g,'&lt;').replace(/>/g,'&gt;'));
    vm.$forceUpdate();
    if (!firstLog) {
      firstLog = true;
    } else if (state.autoscroll) {
      window.scrollTo(0, document.body.scrollHeight);
    }
  };

  return {
    template: '#run',
    mixins: [WebsocketHandler, Utils, ProgressUpdater],
    data: function() {
      return state;
    },
    methods: {
      status: function(data) {
        state.jobsRunning = [];
        state.job = data;
        state.latestNum = data.latestNum;
        state.jobsRunning = [data];
      },
      job_started: function(data) {
        state.latestNum++;
        this.$forceUpdate();
      },
      job_completed: function(data) {
        state.job = data;
        state.jobsRunning = [];
        this.$forceUpdate();
      },
      runComplete: function(run) {
        return !!run && (run.result === 'aborted' || run.result === 'failed' || run.result === 'success');
      },
    },
    beforeRouteEnter(to, from, next) {
      next(vm => {
        state.log = '';
        vm.logws = wsp(to.path + '/log');
        vm.logws.onmessage = function(msg) {
          logHandler(vm, msg.data);
        }
      });
    },
    beforeRouteUpdate(to, from, next) {
      var vm = this;
      vm.logws.close();
      state.log = '';
      vm.logws = wsp(to.path + '/log');
      vm.logws.onmessage = function(msg) {
        logHandler(vm, msg.data);
      }
      next();
    },
    beforeRouteLeave(to, from, next) {
      this.logws.close();
      next();
    }
  };
}();

// For all charts, set miniumum Y to 0
Chart.scaleService.updateScaleDefaults('linear', {
    ticks: { min: 0 }
});

new Vue({
  el: '#app',
  data: {
    title: '', // populated by status ws message
    clockSkew: 0,
    connected: false,
    notify: 'localStorage' in window && localStorage.getItem('showNotifications') == 1
  },
  computed: {
    supportsNotifications() {
      return 'Notification' in window && Notification.permission !== 'denied';
    }
  },
  methods: {
    toggleNotifications(en) {
      if(Notification.permission !== 'granted')
        Notification.requestPermission(p => this.notify = (p === 'granted'))
      else
        this.notify = en;
    },
    showNotify(msg, data) {
      if(this.notify && msg === 'job_completed')
        new Notification('Job ' + data.result, {
          body: data.name + ' ' + '#' + data.number + ': ' + data.result
        });
    }
  },
  watch: {
    notify(e) { localStorage.setItem('showNotifications', e ? 1 : 0); }
  },
  router: new VueRouter({
    mode: 'history',
    routes: [
      { path: '/',                   component: Home },
      { path: '/jobs',               component: Jobs },
      { path: '/jobs/:name',         component: Job },
      { path: '/jobs/:name/:number', component: Run }
    ],
  }),
});
