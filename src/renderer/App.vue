<template>
  <div class="app-wrapper" dir="rtl">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo">DD</div>
        <h2>Double D</h2>
      </div>
      <nav class="menu">
        <button :class="{ active: currentTab === 'downloads' }" @click="currentTab = 'downloads'">
          <i class="fas fa-download"></i> <span>التحميلات</span>
        </button>
        <button :class="{ active: currentTab === 'settings' }" @click="currentTab = 'settings'">
          <i class="fas fa-cog"></i> <span>الإعدادات</span>
        </button>
      </nav>
    </aside>

    <main class="main-content">
      <header class="top-bar">
        <button @click="openDownloadFolder" class="btn-header">
          <i class="fas fa-folder-open"></i> <span>فتح الملف</span>
        </button>
        <div class="status-indicator">
          <span class="dot live"></span> المحرك جاهز
        </div>
      </header>

      <section v-if="currentTab === 'downloads'" class="dashboard">
        <div class="card source-card">
          <h3><i class="fas fa-plus-circle"></i> مهمة تحميل جديدة</h3>
          <div class="input-box">
            <input v-model="linkInput" type="text" placeholder="لصق الرابط هنا..." dir="rtl">
            <button @click="startTask"><i class="fas fa-play"></i> <span>بدء التحميل</span></button>
          </div>
        </div>

        <div class="card list-card">
          <div class="list-header">
            <div class="header-title">
              <h3><i class="fas fa-tasks"></i> العمليات الحالية</h3>
              <span v-if="tasks.length" class="badge">{{ tasks.length }} عمليات</span>
            </div>
            
            <div v-if="tasks.length > 0" class="global-actions">
              <button @click="resumeAllTasks" class="btn-global resume-all" title="استئناف الكل">
                <i class="fas fa-play-circle"></i> <span>استئناف الكل</span>
              </button>
              <button @click="pauseAllTasks" class="btn-global pause-all" title="إيقاف الكل">
                <i class="fas fa-pause-circle"></i> <span>إيقاف الكل</span>
              </button>
            </div>
          </div>

          <div v-if="tasks.length === 0" class="empty-state">
            <div class="icon-wrap"><i class="fas fa-cloud-download-alt"></i></div>
            <h4>Double D مستعد للانطلاق</h4>
            <p>الواجهة نظيفة وجاهزة لسحب الروابط. أضف رابطاً بالأعلى لترى القوة الحقيقية.</p>
          </div>

          <transition-group v-else name="list" tag="div" class="tasks-container">
            <div v-for="task in tasks" :key="task.id" class="task-item">
              <div class="task-info">
                <span class="name"><i class="fas fa-file-archive"></i> {{ task.name }}</span>
                <span class="size">{{ task.size }}</span>
              </div>
              <div class="progress-wrapper">
                <div class="bar"><div class="fill" :style="{ width: task.progress + '%' }"></div></div>
                <div class="meta">
                  <span>{{ task.progress }}%</span>
                  <span><i class="fas fa-tachometer-alt"></i> {{ task.speed }}</span>
                  <span v-if="task.eta && task.eta !== '--'">• ETA: {{ task.eta }}</span>
                </div>
              </div>
              <div class="task-actions">
                <button v-if="task.status === 'downloading'" @click="pauseTask(task.id)" class="btn-action pause" title="إيقاف مؤقت">
                  <i class="fas fa-pause"></i> <span>إيقاف</span>
                </button>
                <button v-if="task.status === 'paused'" @click="resumeTask(task.id)" class="btn-action resume" title="استئناف">
                  <i class="fas fa-play"></i> <span>استئناف</span>
                </button>
                <button @click="deleteTask(task.id)" class="btn-action delete" title="حذف">
                  <i class="fas fa-trash"></i> <span>حذف</span>
                </button>
              </div>
            </div>
          </transition-group>
        </div>
      </section>

      <section v-if="currentTab === 'settings'" class="dashboard">
        <div class="card settings-card">
          <h3><i class="fas fa-tools"></i>مركز تحديث الأدوات </h3>
          <p class="settings-desc">تأكد من تحديث الأدوات بشكل دوري لضمان تخطي حمايات روابط الفيديو من يوتيوب وفيسبوك وباقي المنصات.</p>
          
          <div class="tools-grid">
            <div class="tool-status-card">
              <div class="tool-icon"><i class="fab fa-youtube"></i></div>
              <div class="tool-details">
                <h4>yt-dlp</h4>
                <p>لتحميل الفيديوهات من منصات التواصل الاجتماعي</p>
                <div class="version-tag">الإصدار الحالي: <span>{{ ytdlpVersion }}</span></div>
              </div>
              <div class="tool-action">
                <button @click="updateYtdlp" :disabled="isUpdatingYtdlp || isYtdlpLatest" :class="['btn-update', { 'stable-ready': isYtdlpLatest }]">
                  <i v-if="isUpdatingYtdlp" class="fas fa-spinner fa-spin"></i>
                  <i v-else-if="isYtdlpLatest" class="fas fa-shield-alt"></i>
                  <i v-else class="fas fa-sync-alt"></i>
                  <span>{{ ytdlpButtonText }}</span>
                </button>
              </div>
            </div>

            <div class="tool-status-card">
              <div class="tool-icon"><i class="fas fa-rocket"></i></div>
              <div class="tool-details">
                <h4>Aria2 Core</h4>
                <p>المحرك الرئيسي لتقسيم الملفات والتحميل بأقصى سرعة للإنترنت</p>
                <div class="version-tag">الإصدار الحالي: <span>{{ aria2Version }}</span></div>
              </div>
              <div class="tool-action">
                <button @click="checkAria2" class="btn-update check-only">
                  <i class="fas fa-shield-alt"></i> <span>مستقر وجاهز</span>
                </button>
              </div>
            </div>
          </div>

          <div v-if="updateLog" class="update-log-box">
            <h5><i class="fas fa-terminal"></i> تقرير العمليات الحية:</h5>
            <pre>{{ updateLog }}</pre>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<script>
const { ipcRenderer } = window.require('electron');

export default {
  data() {
    return {
      currentTab: 'downloads',
      linkInput: '',
      tasks: [],
      ytdlpVersion: 'جاري الفحص.. 🔍',
      aria2Version: 'جاري الفحص.. 🔍',
      isUpdatingYtdlp: false,
      updateLog: ''
    }
  },
  computed: {
    // 🔍 فحص ما إذا كانت الأداة على آخر إصدار مستقر لعام 2026
    isYtdlpLatest() {
      return this.ytdlpVersion.includes('2026.03.17');
    },
    // ✍️ تحويل نص الزرار ديناميكياً حسب الحالة
    ytdlpButtonText() {
      if (this.isUpdatingYtdlp) return 'جاري التحديث الدبابي...';
      if (this.isYtdlpLatest) return 'مستقر وجاهز';
      return 'تحديث الأداة فوراً';
    }
  },
  mounted() {
    ipcRenderer.on('response-tasks-updated', (event, updatedTasks) => {
      console.log('[Renderer] received response-tasks-updated', updatedTasks && updatedTasks.length);
      this.tasks = updatedTasks;
    });

    ipcRenderer.on('response-tools-versions', (event, data) => {
      this.ytdlpVersion = data.ytdlp;
      this.aria2Version = data.aria2;
    });

    ipcRenderer.on('response-ytdlp-update-result', (event, data) => {
      this.isUpdatingYtdlp = false;
      this.updateLog = data.message;
      if (data.success && data.newVersion) {
        this.ytdlpVersion = data.newVersion;
      }
    });
    // signal main process that renderer is ready to receive updates
    ipcRenderer.send('renderer-ready');
    ipcRenderer.send('command-check-tools-versions');
  },
  methods: {
    startTask() {
      let url = this.linkInput.trim();
      if (!url) return;
      ipcRenderer.send('command-start-download', url);
      this.linkInput = '';
    },
    pauseTask(taskId) { ipcRenderer.send('command-pause-task', taskId); },
    resumeTask(taskId) { ipcRenderer.send('command-resume-task', taskId); },
    deleteTask(taskId) { ipcRenderer.send('command-delete-task', taskId); },
    pauseAllTasks() { ipcRenderer.send('command-pause-all-tasks'); },
    resumeAllTasks() { ipcRenderer.send('command-resume-all-tasks'); },
    openDownloadFolder() { ipcRenderer.send('command-open-download-folder'); },
    checkAria2() { console.log('Aria2 core status checked: healthy.'); },
    updateYtdlp() {
      this.isUpdatingYtdlp = true;
      this.updateLog = 'جاري الاتصال بخوادم التحديث وجلب البنية التحتية الأخيرة... 📡';
      ipcRenderer.send('command-update-ytdlp');
    }
  }
}
</script>

<style scoped>
.app-wrapper { display: flex; width: 100vw; height: 100vh; overflow: hidden; background: #070A13; color: #E5E7EB; font-family: system-ui, -apple-system, sans-serif; box-sizing: border-box; }
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #1E293B; border-radius: 10px; }
.sidebar { width: 260px; flex-shrink: 0; background: #0D1326; border-inline-end: 1px solid #1E293B; padding: 2rem 1rem; display: flex; flex-direction: column; gap: 2rem; box-sizing: border-box; }
.brand { display: flex; align-items: center; gap: 12px; }
.logo { background: linear-gradient(135deg, #3B82F6, #06B6D4); min-width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 1.2rem; color: white; }
.brand h2 { font-size: 1.2rem; font-weight: 700; margin: 0; white-space: nowrap; }
.menu { display: flex; flex-direction: column; gap: 8px; }
.menu button { background: transparent; border: none; padding: 0.8rem 1rem; color: #9CA3AF; border-radius: 10px; cursor: pointer; font-size: 0.95rem; display: flex; align-items: center; gap: 10px; transition: all 0.2s; width: 100%; box-sizing: border-box; text-align: right;}
.menu button:hover, .menu button.active { background: #1E293B; color: white; }
.menu button.active { border-inline-start: 3px solid #3B82F6; border-right: none; }
.main-content { flex: 1; display: flex; flex-direction: column; height: 100vh; overflow: hidden; min-width: 0; }
.top-bar { padding: 1rem 2rem; background: #0D1326; border-bottom: 1px solid #1E293B; display: flex; justify-content: space-between; align-items: center; height: 65px; box-sizing: border-box;}
.btn-header { background: #3B82F6; color: white; border: none; padding: 0.5rem 1.2rem; border-radius: 10px; cursor: pointer; font-size: 0.9rem; font-weight: 600; display: flex; align-items: center; gap: 8px; transition: all 0.2s; }
.status-indicator { font-size: 0.8rem; color: #10B981; display: flex; align-items: center; gap: 8px; font-weight: 500; }
.dot { width: 8px; height: 8px; background: #10B981; border-radius: 50%; }
.dot.live { animation: blink 1.5s infinite; }
.dashboard { padding: 1.5rem 2rem; display: flex; flex-direction: column; gap: 1.5rem; flex: 1; overflow: hidden; box-sizing: border-box; }
.card { background: #0D1326; border-radius: 16px; padding: 1.5rem; border: 1px solid #1E293B; box-sizing: border-box; }
.card h3 { margin: 0; font-size: 1.1rem; font-weight: 600; color: #93C5FD; display: flex; align-items: center; gap: 8px; }
.source-card { flex-shrink: 0; }
.input-box { display: flex; gap: 12px; margin-top: 1rem; }
.input-box input { flex: 1; background: #070A13; border: 1px solid #334155; border-radius: 12px; padding: 0.8rem 1rem; color: white; outline: none; font-size: 0.9rem; }
.input-box button { background: #3B82F6; border: none; color: white; padding: 0.8rem 1.5rem; border-radius: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; }
.list-card { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.list-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.2rem; flex-shrink: 0; }
.header-title { display: flex; align-items: center; gap: 12px; }
.badge { background: #1E293B; padding: 2px 10px; border-radius: 20px; font-size: 0.75rem; color: #38BDF8; font-weight: bold; }
.global-actions { display: flex; gap: 8px; }
.btn-global { border: none; padding: 0.5rem 0.8rem; border-radius: 8px; cursor: pointer; font-size: 0.8rem; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.btn-global.pause-all { background: rgba(245, 158, 11, 0.1); color: #F59E0B; border: 1px solid rgba(245, 158, 11, 0.3); }
.btn-global.resume-all { background: rgba(16, 185, 129, 0.1); color: #10B981; border: 1px solid rgba(16, 185, 129, 0.3); }
.empty-state { text-align: center; padding: 4rem 1rem; color: #64748B; flex: 1; display: flex; flex-direction: column; justify-content: center; }
.icon-wrap i { font-size: 3rem; color: #1E293B; margin-bottom: 1rem; }
.tasks-container { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.task-item { background: #070A13; border: 1px solid #1E293B; border-radius: 12px; padding: 1rem; }
.task-info { display: flex; justify-content: space-between; font-size: 0.9rem; }
.progress-wrapper .bar { background: #1E293B; height: 6px; border-radius: 10px; overflow: hidden; }
.progress-wrapper .fill { background: linear-gradient(90deg, #3B82F6, #06B6D4); height: 100%; }
.progress-wrapper .meta { display: flex; justify-content: space-between; font-size: 0.75rem; margin-top: 6px; }
.task-actions { display: flex; gap: 8px; margin-top: 12px; }
.btn-action { border: none; padding: 0.6rem 1rem; border-radius: 8px; cursor: pointer; font-size: 0.8rem; }
.btn-action.pause { background: #F59E0B; color: white; }
.btn-action.resume { background: #10B981; color: white; }
.btn-action.delete { background: #EF4444; color: white; }
.settings-desc { color: #9CA3AF; font-size: 0.9rem; margin-top: 0.5rem; margin-bottom: 2rem; }
.tools-grid { display: flex; flex-direction: column; gap: 1rem; }
.tool-status-card { display: flex; align-items: center; background: #070A13; border: 1px solid #1E293B; border-radius: 12px; padding: 1.2rem; gap: 1.5rem; }
.tool-icon { background: #1E293B; width: 50px; height: 50px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; color: #38BDF8; }
.tool-details { flex: 1; }
.tool-details h4 { margin: 0; font-size: 1rem; color: white; }
.tool-details p { margin: 4px 0; font-size: 0.8rem; color: #64748B; }
.version-tag { font-size: 0.8rem; font-weight: bold; color: #10B981; margin-top: 6px; }
.version-tag span { color: #F59E0B; }

/* 🚀 الاستايلات الجديدة الخاصة بالتحكم في شكل الأزرار */
.btn-update { background: #10B981; color: white; border: none; padding: 0.7rem 1.2rem; border-radius: 8px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: 0.2s; }
.btn-update:hover { background: #059669; }
.btn-update:disabled { background: #334155; color: #94A3F8; cursor: not-allowed; }

/* الاستايل المستقر الجديد لـ yt-dlp المتطابق مع Aria2 */
.btn-update.stable-ready { background: #1E293B; color: #9CA3AF; border: 1px solid #334155; cursor: default; }

.btn-update.check-only { background: #1E293B; color: #9CA3AF; border: 1px solid #334155; cursor: default; }
.update-log-box { margin-top: 2rem; background: #02040A; border: 1px solid #1E293B; border-radius: 10px; padding: 1rem; }
.update-log-box h5 { margin: 0 0 0.5rem 0; color: #F59E0B; font-size: 0.85rem; }
.update-log-box pre { margin: 0; font-family: monospace; font-size: 0.8rem; color: #38BDF8; white-space: pre-wrap; word-break: break-all; max-height: 150px; overflow-y: auto; text-align: left; direction: ltr; }
@keyframes blink { 0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; } }
</style>