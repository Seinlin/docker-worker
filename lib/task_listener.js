/**
Primary interface which handles listening for messages and initializing the
execution of tasks.
*/

var QUEUE_PREFIX = 'worker/v1/';

var debug = require('debug')('docker-worker:task-listener');
var taskcluster = require('taskcluster-client');
var coPromise = require('co-promise');
var co = require('co');
var request = require('superagent-promise');
var os = require('os');

var Task = require('./task');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var TaskQueue = require('./queueservice');
var exceedsDiskspaceThreshold = require('./util/capacity').exceedsDiskspaceThreshold;
var VideoDeviceManager = require('./devices/video_device_manager');
var AudioDeviceManager = require('./devices/audio_device_manager');
var CpuDeviceManager = require('./devices/cpu_device_manager');

const DEVICE_MANAGERS = {
  'loopbackVideo': new VideoDeviceManager(),
  'loopbackAudio': new AudioDeviceManager()
};

let cpuDeviceManager = new CpuDeviceManager();

/**
@param {Configuration} config for worker.
*/
export default class TaskListener extends EventEmitter {
  constructor(runtime) {
    super();

    this.pending = 0;
    this.runtime = runtime;
    this.capacity = runtime.capacity;
    this.runningTasks = [];
    this.taskQueue = new TaskQueue(this.runtime);
    this.taskPollInterval = this.runtime.taskQueue.pollInterval;
  }

  listenForShutdowns() {
    // If node will be shutdown, stop consuming events.
    if (this.runtime.shutdownManager) {
      this.runtime.shutdownManager.once(
        'nodeTermination', () => {
          debug('nodeterm');
          async () => {
            await this.pause();
            for(let state of this.runningTasks) {
              state.handler.abort('worker-shutdown');
              this.cleanupRunningState(state);
            }
          }();
        }.bind(this)
      );
    }
  }

  async cancelTask(message) {
    var runId = message.payload.runId;
    var reason = message.payload.status.runs[runId].reasonResolved;
    if (reason !== 'canceled') return;

    var taskId = message.payload.status.taskId;
    var state = this.runningTasks.find((state) => {
      let { handler } = state;
      return (handler.status.taskId === taskId && handler.runId === runId);
    });

    if (!state) {
      debug('task not found to cancel');
      return;
    }

    this.runtime.log('cancelling task', {taskId: message.payload.status.taskId});
    state.handler.cancel(reason);
    this.cleanupRunningState(state);
  }

  async listenForCancelEvents() {
    var queue = this.runtime.queue;

    var queueEvents = new taskcluster.QueueEvents();

    var cancelListener = new taskcluster.PulseListener({
      credentials: this.runtime.pulse
    });

    await cancelListener.bind(queueEvents.taskException({
      workerId: this.runtime.workerId,
      workerType: this.runtime.workerType,
      workerGroup: this.runtime.workerGroup,
      provisionerId: this.runtime.provisionerId
    }));

    cancelListener.on('message', this.cancelTask.bind(this));
    cancelListener.on('error', (error) => {
      // If an error occurs, log and remove the cancelListener.
      // In the future errors could be handled on the PulseListener level.
      this.runtime.log('[alert operator] listener error', { err: error });
      delete this.cancelListener;
    });

    await cancelListener.resume();
    return cancelListener;
  }

  async getTasks() {
    // Number of tasks we could claim
    let availabileCapacity = this.capacity - this.pending;
    if (availabileCapacity <= 0)  return;

    var exceedsThreshold = await exceedsDiskspaceThreshold(
      this.runtime.dockerVolume,
      this.runtime.capacityManagement.diskspaceThreshold,
      availabileCapacity,
      this.runtime.log
    );
    // Do not claim tasks if not enough resources are available
    if (exceedsThreshold) return;

    let claims = await this.taskQueue.claimWork(availabileCapacity);
    claims.forEach(this.runTask.bind(this));
  }

  scheduleTaskPoll(nextPoll=this.taskPollInterval) {
    this.pollTimeoutId = setTimeout(() => {
      async () => {
        clearTimeout(this.pollTimeoutId);

        try {
          await this.getTasks();
        }
        catch (e) {
          this.runtime.log('[alert-operator] task retrieval error', {
              message: e.toString(),
              err: e,
              stack: e.stack
          });
        }
        this.scheduleTaskPoll();
      }();
    }.bind(this), nextPoll);
  }

  async connect() {
    debug('begin consuming tasks');
    //refactor to just have shutdown manager call terminate()
    this.listenForShutdowns();
    this.taskQueue = new TaskQueue(this.runtime);

    this.cancelListener = await this.listenForCancelEvents();

    // Scheduled the next poll very soon use the error handling it provides.
    this.scheduleTaskPoll(1);
  }

  async close() {
    clearTimeout(this.pollTimeoutId);
    if(this.cancelListener) return await this.cancelListener.close();
  }

  /**
  Halt the flow of incoming tasks (but handle existing ones).
  */
  async pause() {
    clearTimeout(this.pollTimeoutId);
    if(this.cancelListener) return await this.cancelListener.pause();
  }

  /**
  Resume the flow of incoming tasks.
  */
  async resume() {
    this.scheduleTaskPoll();
    if(this.cancelListener) return await this.cancelListener.resume();
  }

  isIdle() {
    return this.pending === 0;
  }

  incrementPending() {
    // After going from an idle to a working state issue a 'working' event.
    if (++this.pending === 1) {
      this.emit('working', this);
    }
  }

  decrementPending() {
    this.pending--;
    if (this.pending === 0) {
      this.emit('idle', this);
    }
  }

  /**
  Cleanup state of a running container (should apply to all states).
  */
  cleanupRunningState(state) {
    if (!state) return;

    if (state.devices) {
      for (let device in state.devices) {
        state.devices[device].release();
      }
    }
  }

  /**
  * Run task that has been claimed.
  */
  async runTask(claim) {
    try {
      this.runtime.log('run task', { taskId: claim.status.taskId, runId: claim.runId });
      this.incrementPending();
      // Fetch full task definition.
      var task = await this.runtime.queue.task(claim.status.taskId);

      // Date when the task was created.
      var created = new Date(task.created);

      // Reference to state of this request...
      let runningState = {
        devices: {}
      };

      // Only record this value for first run!
      if (!claim.status.runs.length) {
        // Record a stat which is the time between when the task was created and
        // the first time a worker saw it.
        this.runtime.stats.time('tasks.time.to_reach_worker', created);
      }

      let options = {};

      // Configure cpuset options if needed...
      if (this.runtime.isolatedContainers) {
        runningState.devices['cpu'] = cpuDeviceManager.getAvailableDevice();
        options.cpuset = runningState.devices['cpu'].id;
      }

      let taskCapabilities = task.payload.capabilities || {};
      if (taskCapabilities.devices) {
        options.devices = {};
        debug('Aquiring task payload specific devices');
        for (let device in taskCapabilities.devices) {
          if (!DEVICE_MANAGERS[device]) throw new Error('Unrecognized device requested');

          runningState.devices[device] = DEVICE_MANAGERS[device].getAvailableDevice();
          options.devices[device] = runningState.devices[device];
        }
      }

      // Create "task" to handle all the task specific details.
      var taskHandler = new Task(this.runtime, task, claim, options);
      runningState.handler = taskHandler;

      var taskIndex = this.runningTasks.push(runningState);
      taskIndex = taskIndex-1;

      // Run the task and collect runtime metrics.
      await taskHandler.start();
      this.decrementPending();
      this.cleanupRunningState(runningState);
      this.runningTasks.splice(taskIndex, 1);
    }
    catch (e) {
      this.runningTasks.splice(taskIndex, 1);
      if (task) {
        this.runtime.log('task error', {
          taskId: claim.status.taskId,
          runId: task.runId,
          message: e.toString(),
          stack: e.stack,
          err: e
        });
      } else {
        this.runtime.log('task error', {
          message: e.toString(),
          err: e
        });
      }
      this.cleanupRunningState(runningState);
      this.decrementPending();
    }
  }
}
