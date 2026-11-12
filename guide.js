// SangeetPitara User Manual Interactive Controller
// External script compliant with strict CSP (script-src 'self')

(function () {
  'use strict';

  const TOPIC_ORDER = ['creating-room', 'joining-room', 'host-room', 'inviting-users', 'other-feature'];

  function initGuide() {
    const gridView = document.getElementById('topicsGridView');
    const docView = document.getElementById('topicDocView');
    const docPanels = document.querySelectorAll('.topic-panel');
    const topicCards = document.querySelectorAll('.topic-card');

    if (!gridView || !docView) return;

    // Show topic detail view
    function showTopic(topicId) {
      if (!TOPIC_ORDER.includes(topicId)) {
        showGridView();
        return;
      }

      // Hide grid, show doc container
      gridView.style.display = 'none';
      docView.style.display = 'block';

      // Show matching panel, hide others
      docPanels.forEach(panel => {
        if (panel.id === 'panel-' + topicId) {
          panel.style.display = 'block';
        } else {
          panel.style.display = 'none';
        }
      });

      // Update URL hash without jumping
      if (window.location.hash !== '#' + topicId) {
        history.pushState(null, '', '#' + topicId);
      }

      // Scroll smoothly to top
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Show initial 5-boxes grid view
    function showGridView() {
      docView.style.display = 'none';
      gridView.style.display = 'block';
      docPanels.forEach(panel => (panel.style.display = 'none'));

      if (window.location.hash) {
        history.pushState(null, '', window.location.pathname);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Attach click events to topic cards and their links
    topicCards.forEach(card => {
      card.addEventListener('click', (e) => {
        const topic = card.getAttribute('data-topic');
        if (topic) {
          e.preventDefault();
          showTopic(topic);
        }
      });
    });

    // Attach click events to all "Back to Topics" buttons
    document.querySelectorAll('.back-to-topics-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        showGridView();
      });
    });

    // Attach click events to topic navigation links (Next / Previous)
    document.querySelectorAll('.topic-nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        const target = link.getAttribute('data-target');
        if (target) {
          e.preventDefault();
          showTopic(target);
        }
      });
    });

    // Host room sub-mode switcher (Desktop vs Mobile vs File)
    document.querySelectorAll('.submode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        document.querySelectorAll('.submode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const desktopEl = document.getElementById('host-mode-desktop');
        const mobileEl = document.getElementById('host-mode-mobile');
        const fileEl = document.getElementById('host-mode-file');

        if (desktopEl) desktopEl.style.display = (mode === 'desktop') ? 'grid' : 'none';
        if (mobileEl) mobileEl.style.display = (mode === 'mobile') ? 'grid' : 'none';
        if (fileEl) fileEl.style.display = (mode === 'file') ? 'grid' : 'none';
      });
    });

    // Listen to browser Back/Forward navigation
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace('#', '');
      if (hash && TOPIC_ORDER.includes(hash)) {
        showTopic(hash);
      } else {
        showGridView();
      }
    });

    // Check initial hash on page load
    const initialHash = window.location.hash.replace('#', '');
    if (initialHash && TOPIC_ORDER.includes(initialHash)) {
      showTopic(initialHash);
    } else {
      showGridView();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGuide);
  } else {
    initGuide();
  }
})();
