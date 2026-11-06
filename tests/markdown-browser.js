/* Open markdown-browser.html for tests using the browser's real HTML parser. */
function runMarkdownBrowserTests() {
  let checks=0;
  function check(condition,message){if(!condition)throw new Error(message);checks++;}
  const card=(name,data)=>'<card name="'+name+'" value="data:'+encodeURIComponent(JSON.stringify(data))+'"></card>';
  const convert=html=>LakeMarkdown.convert(html);
  check(convert('<p>A &amp; B &lt; C &#x1F600;</p>')==='A &amp; B &lt; C 😀\n','Entities must survive parsing');
  check(convert('<p>before<cursor />after</p><p>next</p>')==='beforeafter\n\nnext\n','Self-closing editor marker must preserve following text');
  check(convert('<p><code>a_b &lt; b</code></p>')==='`a_b < b`\n','Inline code must stay literal');
  check(convert('<ul><li>outer<ul><li>inner</li></ul></li></ul>').includes('  - inner'),'Nested lists');
  check(convert('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>').includes('| c | d |'),'Native tbody insertion');
  check(convert(card('table',{rows:1,cols:2,html:'<table><tr><td>a</td><td>b</td></tr></table>'})).includes('| a | b |'),'Nested table card');
  check(convert(card('label',{label:'a_b'}))==='a\\_b\n','Label escaping');
  check(convert(card('codeblock',{code:'const x = 1;\n\n\nend',mode:'js'})).includes('1;\n\n\nend'),'Code blank lines');
  check(convert(card('math',{code:'\\[x^2 + y^2\\]'}))==='$$\nx^2 + y^2\n$$\n','Display math delimiters');
  check(convert('<details><summary>A &lt; B</summary><p>body</p></details>').includes('<summary>A &lt; B</summary>'),'Details escaping');
  let rejected=false;try{convert('<iframe src="about:blank"></iframe>');}catch{rejected=true;}
  check(rejected,'Embeds must fail visibly');
  rejected=false;try{convert('<table><tr><td rowspan="2">a</td></tr></table>');}catch{rejected=true;}
  check(rejected,'Merged cells must fail visibly');
  return {checks,passed:true};
}
