"""Native reconstruction editing, with an optional real paid-trial scene. No model calls."""
import json
import base64
import os
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from browser_runtime import launch_browser

BASE = os.environ.get('PAPER_TEST_BASE_URL', 'http://localhost:8788')
QA = Path(os.environ['PAPER_TEST_ROOT']) / 'qa'
QA.mkdir(parents=True, exist_ok=True)
gradient = {'type': 'linear', 'x1': 0, 'y1': 0, 'x2': 0, 'y2': 1,
            'stops': [{'offset': 0, 'color': '#eaf5fc'}, {'offset': 1, 'color': '#b9dbea'}]}
scene = {
    'schema': 'paper-atelier/1', 'id': str(uuid.uuid4()), 'title': 'Native reconstruction fixture', 'width': 900, 'height': 400,
    'style': {'font': 'Arial', 'ink': '#222222', 'muted': '#666666', 'accent': '#2266aa', 'palette': ['#b9dbea'],
              'lineWidth': 2, 'bodySize': 22, 'titleSize': 26, 'illustrationStyle': 'native'},
    'regions': [], 'annotations': [], 'modules': [], 'connectors': [],
    'reconstruction': {'version': 1, 'referenceId': 'fixture', 'assetIds': ['face'], 'iterations': 1, 'fidelityPassed': True},
}
for index, x in enumerate([80, 600]):
    scene['modules'].append({'id': 'node' + str(index), 'title': 'Node ' + str(index), 'role': 'illustration', 'brief': 'Native editing fixture',
                            'x': x, 'y': 70, 'width': 200, 'height': 240, 'contentWidth': 200, 'contentHeight': 240, 'labels': ['Editable label'],
                            'componentIds': [], 'sourceRefs': [], 'method': 'vector-agent', 'status': 'ready',
                            'ports': [{'id': 'side', 'side': 'right' if index == 0 else 'left', 'offset': .5}],
                            'elements': [{'id': 'card' + str(index), 'type': 'rect', 'x': 0, 'y': 0, 'width': 200, 'height': 240,
                                          'radius': 16, 'fill': '#b9dbea', 'gradient': gradient, 'stroke': '#526478'},
                                         {'id': 'label' + str(index), 'type': 'text', 'x': 100, 'y': 170,
                                          'align': 'center', 'text': 'Editable label\n' + str(index), 'fontSize': 22},
                                         {'id': 'face' + str(index), 'type': 'group', 'x': 40, 'y': 30, 'children': [
                                             {'id': 'visor' + str(index), 'type': 'rect', 'x': 0, 'y': 0, 'width': 120, 'height': 80, 'radius': 25, 'fill': '#30485c'},
                                             {'id': 'eye' + str(index), 'type': 'ellipse', 'x': 25, 'y': 25, 'width': 15, 'height': 15, 'fill': '#78eef4'}]}]})
scene['connectors'] = [{'id': 'curve', 'from': 'node0', 'to': 'node1', 'fromPort': 'side', 'toPort': 'side', 'color': '#666666', 'strokeWidth': 3,
                        'curveAnchors': {'start': {'x': 280, 'y': 190}, 'end': {'x': 600, 'y': 190}},
                        'curve': [{'c1': {'x': 380, 'y': 10}, 'c2': {'x': 500, 'y': 10}, 'end': {'x': 600, 'y': 190}}]}]
if os.environ.get('PAPER_VISUAL_TEST_SCENE'):
    scene = json.loads(Path(os.environ['PAPER_VISUAL_TEST_SCENE']).read_text(encoding='utf-8'))

def primitives(items):
    for item in items:
        yield item
        yield from primitives(item.get('children', []))

with sync_playwright() as p:
    browser = launch_browser(p)
    page = browser.new_page(viewport={'width': 1700, 'height': 1050}, accept_downloads=True)
    errors, calls = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    assert page.request.get(BASE + '/api/workbench/status').json().get('dataScope') == 'test', 'Refusing live writes'
    response = page.request.post(BASE + '/api/papers', data={'title': 'QA native objects', 'ideaSpark': 'Isolated native editing trial.', 'materials': [], 'language': 'en'})
    assert response.ok, response.text()
    def unexpected_model(route):
        calls.append(route.request.url)
        route.fulfill(status=500, json={'error': 'Model calls forbidden in GUI editing test'})
    page.route('**/api/runs**', unexpected_model)
    page.goto(BASE + '/?project=' + response.json()['id'], wait_until='networkidle')
    page.locator('[data-module="figures"]').click()
    page.get_by_role('button', name='矢量画板', exact=True).click()
    child = page.frame_locator('iframe[title="论文矢量画板"]')
    child.locator('input[type=file][accept=".json"]').set_input_files({'name': 'native.json', 'mimeType': 'application/json', 'buffer': json.dumps(scene).encode()})
    expect(child.locator('[data-layer-module]')).to_have_count(len(scene['modules']))
    # Compare actual Canvas ink with the exported native renderer. Property-only
    # tests cannot catch a centered anchor being interpreted as a left edge.
    rendered = page.request.post(BASE + '/api/render', data=scene)
    assert rendered.ok, rendered.text()
    ink_agreement = child.locator('canvas.lower-canvas').evaluate('''async (canvas, args) => {
      const picture=new Image(); picture.src=args.png; await picture.decode();
      const expected=document.createElement('canvas');expected.width=canvas.width;expected.height=canvas.height;
      const ctx=expected.getContext('2d'),z=Math.min((canvas.clientWidth-68)/args.width,(canvas.clientHeight-68)/args.height,1);
      const dpr=canvas.width/canvas.clientWidth,tx=(canvas.clientWidth-args.width*z)/2,ty=(canvas.clientHeight-args.height*z)/2;
      ctx.drawImage(picture,tx*dpr,ty*dpr,args.width*z*dpr,args.height*z*dpr);
      const a=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data,b=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      const ink=(pixels,i)=>pixels[i+3]>150&&Math.max(pixels[i],pixels[i+1],pixels[i+2])<90;
      const tolerance=Math.ceil(dpr*2),left=Math.ceil(tx*dpr)+2,top=Math.ceil(ty*dpr)+2,right=Math.floor((tx+args.width*z)*dpr)-2,bottom=Math.floor((ty+args.height*z)*dpr)-2;
      function overlap(source,target){let count=0,matched=0;for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
        const i=(y*canvas.width+x)*4;if(!ink(source,i))continue;count++;let found=false;
        for(let dy=-tolerance;dy<=tolerance&&!found;dy++)for(let dx=-tolerance;dx<=tolerance;dx++){
          if(x+dx>=0&&x+dx<canvas.width&&y+dy>=0&&y+dy<canvas.height&&ink(target,((y+dy)*canvas.width+x+dx)*4)){found=true;break;}}
        if(found)matched++;
      }return count?matched/count:0;}
      return (overlap(a,b)+overlap(b,a))/2;
    }''', {'png': 'data:image/png;base64,' + base64.b64encode(rendered.body()).decode(), 'width': scene['width'], 'height': scene['height']})
    assert ink_agreement > .90, f'Canvas/SVG anchor or line-height disagreement: {ink_agreement}'
    page.screenshot(path=str(QA / 'native-reconstruction.png'))
    owner_index = next(i for i, m in enumerate(scene['modules'])
                       if any(e.get('type') == 'text' for e in primitives(m['elements']))
                       and any(e.get('gradient') and e.get('type') != 'group' for e in primitives(m['elements'])))
    owner = scene['modules'][owner_index]
    child.locator('[data-layer-module]').nth(owner_index).click()
    label = next(e for e in primitives(owner['elements']) if e.get('type') == 'text')
    child.locator('.layer-elements button').filter(has_text=label['text'].replace('\n', ' ')).first.click()
    child.get_by_label('文字', exact=True).fill('Human edited scientific label')
    expect(child.get_by_label('文字', exact=True)).to_have_value('Human edited scientific label')
    child.get_by_title('撤销 Ctrl+Z', exact=True).click()
    expect(child.get_by_label('文字', exact=True)).to_have_value(label['text'])
    child.get_by_title('重做 Ctrl+Shift+Z', exact=True).click()
    # Native gradient paint remains editable in the property inspector.
    card = next(e for e in primitives(owner['elements']) if e.get('gradient') and e.get('type') != 'group')
    child.locator('.layer-elements button').filter(has_text=card['id']).first.click()
    expect(child.get_by_label('填充方式', exact=True)).to_have_value('gradient')
    child.get_by_label('渐变色标 1', exact=True).fill('#dceeff')
    # Drill down into a generated illustration's parts, not an opaque SVG/image.
    detail = next((e for e in primitives(owner['elements']) if e.get('type') not in ['group', 'text'] and e['id'] != card['id']), None)
    if detail:
        child.locator('.layer-elements button').filter(has_text=detail['id']).first.click()
        expect(child.locator('.inspector')).to_be_visible()
    child.get_by_role('button', name='导出', exact=True).click()
    with page.expect_download() as downloading:
        child.get_by_role('menuitem', name='SVG 矢量图', exact=True).click()
    svg = Path(downloading.value.path()).read_text(encoding='utf-8')
    assert '<linearGradient' in svg and '<text' in svg and '<image' not in svg
    assert 'Human edited scientific label' in svg and '#dceeff' in svg
    assert 'data-connector-id' in svg and 'C' in svg
    assert not calls and not errors, {'calls': calls, 'errors': errors}
    browser.close()
    print(json.dumps({'passed': True, 'realTrial': bool(os.environ.get('PAPER_VISUAL_TEST_SCENE')), 'nativeModules': len(scene['modules']),
                      'checks': ['native canvas import', 'Canvas/SVG ink alignment', 'editable text', 'undo/redo', 'editable gradient', 'illustration parts', 'native SVG export'],
                      'canvasSvgInkAgreement': ink_agreement, 'modelCalls': 0}))
