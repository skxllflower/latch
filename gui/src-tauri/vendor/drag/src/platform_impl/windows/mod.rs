// Copyright 2023-2023 CrabNebula Ltd.
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use raw_window_handle::{HasWindowHandle, RawWindowHandle};

use crate::{CursorPosition, DragItem, DragMode, DragOperation, DragResult, Image, Options};

use std::{
    ffi::c_void,
    iter::once,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::Once,
};
use windows::{
    core::*,
    Win32::{
        Foundation::*,
        Graphics::Gdi::{GetObjectW, BITMAP},
        System::Com::*,
        System::Memory::*,
        System::Ole::{DoDragDrop, OleInitialize},
        System::Ole::{
            IDropSource, IDropSource_Impl, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK,
            DROPEFFECT_MOVE,
        },
        System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
        UI::{
            Shell::{
                BHID_DataObject, CLSID_DragDropHelper, Common, IDragSourceHelper, IShellItemArray,
                SHCreateDataObject, SHCreateShellItemArrayFromIDLists, DROPFILES, SHDRAGIMAGE,
            },
            WindowsAndMessaging::GetCursorPos,
        },
    },
};

mod image;

static mut OLE_RESULT: Result<()> = Ok(());
static OLE_UNINITIALIZE: Once = Once::new();
fn init_ole() {
    OLE_UNINITIALIZE.call_once(|| {
        unsafe {
            OLE_RESULT = OleInitialize(Some(std::ptr::null_mut()));
        }
        // I guess we never deinitialize for now?
        // OleUninitialize
    });
}

#[implement(IDataObject)]
struct DataObject {
    files: Vec<PathBuf>,
    inner_shell_obj: IDataObject,
}

// Delegating wrapper that adds IDataObjectAsyncCapability (answering
// VARIANT_TRUE) on top of the shell's own data object. The shell data object
// from BindToHandler(BHID_DataObject) exposes the interface but hard-refuses
// SetAsyncMode (GetAsyncMode stays FALSE no matter what is written — probed
// live on Win11), and with async capability off Explorer performs the whole
// paste SYNCHRONOUSLY inside IDropTarget::Drop — including the
// "Replace or Skip Files" conflict prompt — wedging DoDragDrop (and the
// calling UI thread, i.e. the entire app) until the user answers. With this
// wrapper announcing async support, Explorer marshals the object to a
// background thread, returns from Drop immediately, and runs the
// copy/move/prompt over there. Every IDataObject call is forwarded to the
// inner shell object untouched, so formats/enumeration/SetData behave
// exactly as before for every target.
#[implement(IDataObject, windows::Win32::UI::Shell::IDataObjectAsyncCapability)]
struct AsyncCapableDataObject {
    inner: IDataObject,
    async_mode: std::cell::Cell<bool>,
    in_operation: std::cell::Cell<bool>,
    shell_op: Option<std::sync::Arc<crate::ShellOpState>>,
}

#[allow(non_snake_case)]
impl IDataObject_Impl for AsyncCapableDataObject {
    fn GetData(&self, pformatetc: *const FORMATETC) -> Result<STGMEDIUM> {
        unsafe { self.inner.GetData(pformatetc) }
    }
    fn GetDataHere(&self, pformatetc: *const FORMATETC, pmedium: *mut STGMEDIUM) -> Result<()> {
        unsafe { self.inner.GetDataHere(pformatetc, pmedium) }
    }
    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        unsafe { self.inner.QueryGetData(pformatetc) }
    }
    fn GetCanonicalFormatEtc(
        &self,
        pformatectin: *const FORMATETC,
        pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        unsafe { self.inner.GetCanonicalFormatEtc(pformatectin, pformatetcout) }
    }
    fn SetData(
        &self,
        pformatetc: *const FORMATETC,
        pmedium: *const STGMEDIUM,
        frelease: BOOL,
    ) -> Result<()> {
        unsafe { self.inner.SetData(pformatetc, pmedium, frelease) }
    }
    fn EnumFormatEtc(&self, dwdirection: u32) -> Result<IEnumFORMATETC> {
        unsafe { self.inner.EnumFormatEtc(dwdirection) }
    }
    fn DAdvise(
        &self,
        pformatetc: *const FORMATETC,
        advf: u32,
        padvsink: Option<&IAdviseSink>,
    ) -> Result<u32> {
        unsafe { self.inner.DAdvise(pformatetc, advf, padvsink) }
    }
    fn DUnadvise(&self, dwconnection: u32) -> Result<()> {
        unsafe { self.inner.DUnadvise(dwconnection) }
    }
    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        unsafe { self.inner.EnumDAdvise() }
    }
}

#[allow(non_snake_case)]
impl windows::Win32::UI::Shell::IDataObjectAsyncCapability_Impl for AsyncCapableDataObject {
    fn SetAsyncMode(&self, fdoopasync: BOOL) -> Result<()> {
        self.async_mode.set(fdoopasync.as_bool());
        Ok(())
    }
    fn GetAsyncMode(&self) -> Result<BOOL> {
        // VARIANT_TRUE (-1): the shell compares against it explicitly.
        Ok(BOOL(if self.async_mode.get() { -1 } else { 0 }))
    }
    fn StartOperation(&self, _pbcreserved: Option<&IBindCtx>) -> Result<()> {
        self.in_operation.set(true);
        if let Some(op) = &self.shell_op {
            op.started.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        log::debug!("drag: shell async op StartOperation");
        Ok(())
    }
    fn InOperation(&self) -> Result<BOOL> {
        Ok(BOOL(if self.in_operation.get() { -1 } else { 0 }))
    }
    fn EndOperation(
        &self,
        hresult: HRESULT,
        _pbcreserved: Option<&IBindCtx>,
        dweffects: u32,
    ) -> Result<()> {
        self.in_operation.set(false);
        if let Some(op) = &self.shell_op {
            op.end_effects
                .store(dweffects, std::sync::atomic::Ordering::SeqCst);
            op.ended.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        log::debug!("drag: shell async op EndOperation hr={hresult:?} effects={dweffects:#x}");
        Ok(())
    }
}

#[implement(IDropSource)]
struct DropSource(());

#[implement(IDropSource)]
struct DummyDropSource(());

impl DropSource {
    fn new() -> Self {
        Self(())
    }
}

#[allow(non_snake_case)]
impl IDropSource_Impl for DropSource {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() {
            DRAGDROP_S_CANCEL
        } else if (grfkeystate & MK_LBUTTON) == MODIFIERKEYS_FLAGS(0) {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

impl DummyDropSource {
    fn new() -> Self {
        Self(())
    }
}

#[allow(non_snake_case)]
impl IDropSource_Impl for DummyDropSource {
    fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
        if fescapepressed.as_bool() || (grfkeystate & MK_LBUTTON) == MODIFIERKEYS_FLAGS(0) {
            DRAGDROP_S_CANCEL
        } else {
            S_OK
        }
    }

    fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

impl DataObject {
    // This will be used for sharing text between applications
    #[allow(dead_code)]
    fn new(files: Vec<PathBuf>) -> Self {
        unsafe {
            Self {
                files,
                inner_shell_obj: SHCreateDataObject(None, None, None).unwrap(),
            }
        }
    }

    fn is_supported_format(pformatetc: *const FORMATETC) -> bool {
        if let Some(format_etc) = unsafe { pformatetc.as_ref() } {
            !(format_etc.tymed as i32 != TYMED_HGLOBAL.0
                || format_etc.cfFormat != CF_HDROP.0
                || format_etc.dwAspect != DVASPECT_CONTENT.0)
        } else {
            false
        }
    }

    fn clone_drop_hglobal(&self) -> Result<HGLOBAL> {
        let mut buffer = Vec::new();
        for path in &self.files {
            let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
            buffer.extend(wide_path);
        }
        buffer.push(0);
        let size = std::mem::size_of::<DROPFILES>() + buffer.len() * 2;
        let handle = get_hglobal(size, buffer)?;
        Ok(handle)
    }
}

#[allow(non_snake_case)]
impl IDataObject_Impl for DataObject {
    fn GetData(&self, pformatetc: *const FORMATETC) -> Result<STGMEDIUM> {
        unsafe {
            if Self::is_supported_format(pformatetc) {
                Ok(STGMEDIUM {
                    tymed: TYMED_HGLOBAL.0 as u32,
                    u: STGMEDIUM_0 {
                        hGlobal: self.clone_drop_hglobal()?,
                    },
                    pUnkForRelease: std::mem::ManuallyDrop::new(None),
                })
            } else {
                self.inner_shell_obj.GetData(pformatetc)
            }
        }
    }

    fn GetDataHere(&self, _pformatetc: *const FORMATETC, _pmedium: *mut STGMEDIUM) -> Result<()> {
        Err(Error::new(DV_E_FORMATETC, HSTRING::new()))
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        unsafe {
            if Self::is_supported_format(pformatetc) {
                S_OK
            } else {
                self.inner_shell_obj.QueryGetData(pformatetc)
            }
        }
    }

    fn GetCanonicalFormatEtc(
        &self,
        _pformatectin: *const FORMATETC,
        pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        unsafe { (*pformatetcout).ptd = std::ptr::null_mut() };
        E_NOTIMPL
    }

    fn SetData(
        &self,
        pformatetc: *const FORMATETC,
        pmedium: *const STGMEDIUM,
        frelease: BOOL,
    ) -> Result<()> {
        unsafe { self.inner_shell_obj.SetData(pformatetc, pmedium, frelease) }
    }

    fn EnumFormatEtc(&self, _dwdirection: u32) -> Result<IEnumFORMATETC> {
        Err(Error::new(E_NOTIMPL, HSTRING::new()))
    }

    fn DAdvise(
        &self,
        _pformatetc: *const FORMATETC,
        _advf: u32,
        _padvsink: Option<&IAdviseSink>,
    ) -> Result<u32> {
        Err(Error::new(OLE_E_ADVISENOTSUPPORTED, HSTRING::new()))
    }

    fn DUnadvise(&self, _dwconnection: u32) -> Result<()> {
        Err(Error::new(OLE_E_ADVISENOTSUPPORTED, HSTRING::new()))
    }

    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        Err(Error::new(OLE_E_ADVISENOTSUPPORTED, HSTRING::new()))
    }
}

// Map DoDragDrop's out-parameter to the public DragOperation. Operate on the
// raw u32 so we don't depend on bitflag operator impls across windows-rs
// versions. MOVE takes precedence: if the target set the move bit, the source
// must delete the original.
fn effect_to_operation(effect: DROPEFFECT) -> DragOperation {
    let v = effect.0;
    if v & DROPEFFECT_MOVE.0 != 0 {
        DragOperation::Move
    } else if v & DROPEFFECT_COPY.0 != 0 {
        DragOperation::Copy
    } else if v & DROPEFFECT_LINK.0 != 0 {
        DragOperation::Link
    } else {
        DragOperation::None
    }
}

pub fn start_drag<W: HasWindowHandle, F: Fn(DragResult, CursorPosition) + Send + 'static>(
    handle: &W,
    item: DragItem,
    image: Image,
    on_drop_callback: F,
    options: Options,
) -> crate::Result<()> {
    if let Ok(RawWindowHandle::Win32(_w)) = handle.window_handle().map(|h| h.as_raw()) {
        match item {
            DragItem::Files(files) => {
                init_ole();
                unsafe {
                    #[allow(static_mut_refs)]
                    if let Err(e) = &OLE_RESULT {
                        return Err(e.clone().into());
                    }
                }

                let mut paths = Vec::new();
                for f in files {
                    paths.push(dunce::canonicalize(f)?);
                }

                let inner = get_file_data_object(&paths).unwrap();
                // Wrap the shell data object with real async-drop capability so
                // a shell paste (and its conflict prompt) can never wedge
                // DoDragDrop — see AsyncCapableDataObject.
                let data_object: IDataObject = AsyncCapableDataObject {
                    inner,
                    async_mode: std::cell::Cell::new(true),
                    in_operation: std::cell::Cell::new(false),
                    shell_op: options.shell_op.clone(),
                }
                .into();
                let drop_source: IDropSource = DropSource::new().into();

                unsafe {
                    if let Some(drag_image) = get_drag_image(image) {
                        if let Ok(helper) =
                            create_instance::<IDragSourceHelper>(&CLSID_DragDropHelper)
                        {
                            let _ = helper.InitializeFromBitmap(&drag_image, &data_object);
                        }
                    }

                    let mut out_dropeffect = DROPEFFECT::default();
                    // When allow_move is set, offer BOTH copy and move so the
                    // target picks (Explorer moves within a volume, DAWs copy);
                    // out_dropeffect then tells us which it performed. Otherwise
                    // offer just the single `mode` effect (legacy behavior).
                    let effect = if options.allow_move {
                        DROPEFFECT(DROPEFFECT_COPY.0 | DROPEFFECT_MOVE.0)
                    } else {
                        match options.mode {
                            DragMode::Copy => DROPEFFECT_COPY,
                            DragMode::Move => DROPEFFECT_MOVE,
                        }
                    };

                    let drop_result =
                        DoDragDrop(&data_object, &drop_source, effect, &mut out_dropeffect);
                    let mut pt = POINT { x: 0, y: 0 };
                    GetCursorPos(&mut pt)?;
                    if drop_result == DRAGDROP_S_DROP {
                        let op = effect_to_operation(out_dropeffect);
                        on_drop_callback(
                            DragResult::Dropped(op),
                            CursorPosition { x: pt.x, y: pt.y },
                        );
                    } else {
                        // DRAGDROP_S_CANCEL
                        on_drop_callback(DragResult::Cancel, CursorPosition { x: pt.x, y: pt.y });
                    }
                }
            }
            DragItem::Data { .. } => {
                init_ole();
                unsafe {
                    #[allow(static_mut_refs)]
                    if let Err(e) = &OLE_RESULT {
                        return Err(e.clone().into());
                    }
                }

                let paths = vec![dunce::canonicalize("./")?];

                let data_object: IDataObject = get_file_data_object(&paths).unwrap();
                let drop_source: IDropSource = DummyDropSource::new().into();

                unsafe {
                    if let Some(drag_image) = get_drag_image(image) {
                        if let Ok(helper) =
                            create_instance::<IDragSourceHelper>(&CLSID_DragDropHelper)
                        {
                            let _ = helper.InitializeFromBitmap(&drag_image, &data_object);
                        }
                    }

                    let mut out_dropeffect = DROPEFFECT::default();
                    let drop_result = DoDragDrop(
                        &data_object,
                        &drop_source,
                        DROPEFFECT_COPY,
                        &mut out_dropeffect,
                    );
                    let mut pt = POINT { x: 0, y: 0 };
                    GetCursorPos(&mut pt)?;
                    if drop_result == DRAGDROP_S_DROP {
                        on_drop_callback(
                            DragResult::Dropped(effect_to_operation(out_dropeffect)),
                            CursorPosition { x: pt.x, y: pt.y },
                        );
                    } else {
                        // DRAGDROP_S_CANCEL
                        on_drop_callback(DragResult::Cancel, CursorPosition { x: pt.x, y: pt.y });
                    }
                }
            }
        }
        Ok(())
    } else {
        Err(crate::Error::UnsupportedWindowHandle)
    }
}

fn get_drag_image(image: Image) -> Option<SHDRAGIMAGE> {
    let hbitmap = match image {
        Image::Raw(bytes) => image::read_bytes_to_hbitmap(&bytes).ok(),
        Image::File(path) => image::read_path_to_hbitmap(&path).ok(),
    };
    hbitmap.map(|hbitmap| unsafe {
        // get image size
        let mut bitmap: BITMAP = BITMAP::default();
        let (width, height) = if 0
            == GetObjectW(
                hbitmap,
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bitmap as *mut BITMAP as *mut c_void),
            ) {
            (128, 128)
        } else {
            (bitmap.bmWidth, bitmap.bmHeight)
        };

        SHDRAGIMAGE {
            sizeDragImage: SIZE {
                cx: width,
                cy: height,
            },
            ptOffset: POINT { x: 0, y: 0 },
            hbmpDragImage: hbitmap,
            crColorKey: COLORREF(0x00000000),
        }
    })
}

fn get_hglobal(size: usize, buffer: Vec<u16>) -> Result<HGLOBAL> {
    let handle = unsafe { GlobalAlloc(GMEM_FIXED, size).unwrap() };
    let ptr = unsafe { GlobalLock(handle) };

    let header = ptr as *mut DROPFILES;
    unsafe {
        (*header).pFiles = std::mem::size_of::<DROPFILES>() as u32;
        (*header).fWide = BOOL(1);
        std::ptr::copy(
            buffer.as_ptr() as *const c_void,
            ptr.add(std::mem::size_of::<DROPFILES>()),
            buffer.len() * 2,
        );
        GlobalUnlock(handle)
    }?;
    Ok(handle)
}

pub fn create_instance<T: Interface + ComInterface>(clsid: &GUID) -> Result<T> {
    unsafe { CoCreateInstance(clsid, None, CLSCTX_ALL) }
}

fn get_file_data_object(paths: &[PathBuf]) -> Option<IDataObject> {
    unsafe {
        let shell_item_array = get_shell_item_array(paths).unwrap();
        shell_item_array.BindToHandler(None, &BHID_DataObject).ok()
    }
}

fn get_shell_item_array(paths: &[PathBuf]) -> Option<IShellItemArray> {
    unsafe {
        let list: Vec<*const Common::ITEMIDLIST> = paths
            .iter()
            .map(|path| get_file_item_id(path).cast_const())
            .collect();
        SHCreateShellItemArrayFromIDLists(&list).ok()
    }
}

fn get_file_item_id(path: &Path) -> *mut Common::ITEMIDLIST {
    unsafe {
        let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
        windows::Win32::UI::Shell::ILCreateFromPathW(PCWSTR::from_raw(wide_path.as_ptr()))
    }
}
