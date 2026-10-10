export function setupTheme(button){
  try{document.documentElement.dataset.theme=localStorage.getItem('threadbridge-theme')??'';}catch{}
  button.addEventListener('click',()=>{
    const dark=document.documentElement.dataset.theme==='dark'||!document.documentElement.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme=dark?'light':'dark';try{localStorage.setItem('threadbridge-theme',dark?'light':'dark');}catch{}
  });
}
