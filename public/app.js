document.getElementById('logout-btn')?.addEventListener('click', async () => {
  await fetch('/logout', {
    method: 'POST',
    credentials: 'include',
  });
  location.href = '/login.html';
});
