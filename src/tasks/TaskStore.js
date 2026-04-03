import { TaskStatus } from './Task.js';

/**
 * In-memory task storage with optional TTL cleanup.
 */
export class TaskStore {
  constructor() {
    /** @type {Map<string, Task>} */
    this.tasks = new Map();
  }

  /**
   * Add a task to the store
   * @param {Task} task
   */
  add(task) {
    this.tasks.set(task.id, task);
  }

  /**
   * Get a task by ID
   * @param {string} id
   * @returns {Task|null}
   */
  get(id) {
    return this.tasks.get(id) || null;
  }

  /**
   * Update a task
   * @param {Task} task
   */
  update(task) {
    if (this.tasks.has(task.id)) {
      this.tasks.set(task.id, task);
    }
  }

  /**
   * Remove a task from the store
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    return this.tasks.delete(id);
  }

  /**
   * Get all tasks
   * @returns {Task[]}
   */
  getAll() {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks by status
   * @param {string} status - TaskStatus value
   * @returns {Task[]}
   */
  getByStatus(status) {
    return this.getAll().filter((t) => t.status === status);
  }

  /**
   * Get tasks by type
   * @param {string} type
   * @returns {Task[]}
   */
  getByType(type) {
    return this.getAll().filter((t) => t.type === type);
  }

  /**
   * Get pending tasks count
   * @returns {number}
   */
  getPendingCount() {
    return this.getByStatus(TaskStatus.PENDING).length;
  }

  /**
   * Get running tasks count
   * @returns {number}
   */
  getRunningCount() {
    return this.getByStatus(TaskStatus.RUNNING).length;
  }

  /**
   * Clear completed and failed tasks older than maxAge
   * @param {number} maxAge - Max age in ms
   * @returns {number} - Number of tasks cleared
   */
  cleanup(maxAge = 3600000) {
    const now = Date.now();
    let cleared = 0;

    for (const [id, task] of this.tasks) {
      if (
        (task.status === TaskStatus.COMPLETED ||
          task.status === TaskStatus.FAILED ||
          task.status === TaskStatus.CANCELLED) &&
        task.completedAt &&
        now - task.completedAt > maxAge
      ) {
        this.tasks.delete(id);
        cleared++;
      }
    }

    return cleared;
  }

  /**
   * Get store statistics
   * @returns {Object}
   */
  getStats() {
    const tasks = this.getAll();
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === TaskStatus.PENDING).length,
      running: tasks.filter((t) => t.status === TaskStatus.RUNNING).length,
      completed: tasks.filter((t) => t.status === TaskStatus.COMPLETED).length,
      failed: tasks.filter((t) => t.status === TaskStatus.FAILED).length,
      cancelled: tasks.filter((t) => t.status === TaskStatus.CANCELLED).length,
    };
  }
}
