// Feed selection and video exploration are two stages of the same reading
// activity. Reply/other scenes remain isolated.
export const matchesScene=(member,requested)=>member==='general'||member===requested||['watch','feed'].includes(member)&&['watch','feed'].includes(requested)
